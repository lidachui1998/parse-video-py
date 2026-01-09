import re

import httpx
import yaml
import os

from .base import BaseParser, ImgInfo, VideoAuthor, VideoInfo
from utils.user_agent import get_user_agent


class RedBook(BaseParser):
    """
    小红书
    """

    @staticmethod
    def _extract_note_id_from_url(url: str) -> str:
        """
        XHS note id is usually a 24-char hex string in URL path.
        Examples:
          - https://www.xiaohongshu.com/explore/<note_id>
          - https://www.xiaohongshu.com/discovery/item/<note_id>
        """
        if not url:
            return ""
        m = re.search(r"/([0-9a-fA-F]{24})(?:[/?#]|$)", url)
        return m.group(1) if m else ""

    @staticmethod
    def _extract_note_id_from_text(html: str) -> str:
        if not html:
            return ""
        # common embeds
        for pat in [
            r'"noteId"\s*:\s*"([0-9a-fA-F]{24})"',
            r'"currentNoteId"\s*:\s*"([0-9a-fA-F]{24})"',
            r'"sourceNoteId"\s*:\s*"([0-9a-fA-F]{24})"',
            r'"note_id"\s*:\s*"([0-9a-fA-F]{24})"',
        ]:
            m = re.search(pat, html)
            if m:
                return m.group(1)
        return ""

    async def parse_share_url(self, share_url: str) -> VideoInfo:
        # IMPORTANT:
        # Upstream repo uses a Windows UA and is observed to work better on some server IPs.
        # We'll try Windows UA first, then fallback to iOS UA.
        xhs_cookie = os.getenv("XHS_COOKIE") or os.getenv("RED_BOOK_COOKIE") or ""

        def _headers(os_hint: str) -> dict:
            h = {"User-Agent": get_user_agent(os_hint)}
            if xhs_cookie:
                h["Cookie"] = xhs_cookie
            return h

        final_url = share_url
        # First hop: many xhslink.com urls 302 to an explore/discovery URL containing note_id.
        async with httpx.AsyncClient(follow_redirects=False) as client:
            r0 = await client.get(share_url, headers=_headers("windows"))
            if r0.status_code in (301, 302, 303, 307, 308):
                final_url = r0.headers.get("location") or share_url

        # Try fetch with Windows UA first; if it looks like anti-bot (missing __INITIAL_STATE__/note),
        # fallback to iOS UA.
        async with httpx.AsyncClient(follow_redirects=True) as client:
            response = await client.get(final_url, headers=_headers("windows"))
            response.raise_for_status()
            landed_url = str(response.url)

            pattern = re.compile(
                pattern=r"window\.__INITIAL_STATE__\s*=\s*(.*?)</script>",
                flags=re.DOTALL,
            )
            find_res = pattern.search(response.text)
            if not find_res or not find_res.group(1):
                # fallback attempt
                response = await client.get(final_url, headers=_headers("ios"))
                response.raise_for_status()
                landed_url = str(response.url)
                find_res = pattern.search(response.text)

        if not find_res or not find_res.group(1):
            raise ValueError("parse video json info from html fail")

        json_data = yaml.safe_load(find_res.group(1)) or {}
        note_id_hint = self._extract_note_id_from_url(landed_url) or self._extract_note_id_from_text(response.text)

        # NOTE: On some server IPs / environments, XHS may return an "anti-bot" state without `note`.
        # Avoid KeyError and return an actionable message instead.
        note_block = json_data.get("note") if isinstance(json_data, dict) else None
        if not isinstance(note_block, dict):
            # Fallback: some versions use `noteData` instead of `note`
            note_data = json_data.get("noteData") if isinstance(json_data, dict) else None
            if isinstance(note_data, dict):
                # try common shapes
                # - noteData.noteDetailMap[note_id].note
                # - noteData.noteDetail.note
                note_id = (
                    note_data.get("currentNoteId")
                    or note_data.get("noteId")
                    or (note_data.get("noteDetail") or {}).get("noteId")
                    or note_id_hint
                )
                if note_id and note_id != "undefined":
                    detail_map = note_data.get("noteDetailMap") or {}
                    node = (detail_map.get(note_id) or {}).get("note") if isinstance(detail_map, dict) else None
                    if isinstance(node, dict):
                        data = node
                    else:
                        nd = note_data.get("noteDetail") or {}
                        data = nd.get("note") if isinstance(nd, dict) else None
                    if isinstance(data, dict):
                        # reuse the rest of parsing logic by setting `note_block`-like variables
                        pass
                    else:
                        keys = list(json_data.keys())[:20] if isinstance(json_data, dict) else []
                        raise Exception(
                            "parse fail: xhs __INITIAL_STATE__ has noteData but unsupported shape "
                            f"(可能被风控/返回结构变化). top_keys={keys}"
                        )
                else:
                    keys = list(json_data.keys())[:20] if isinstance(json_data, dict) else []
                    raise Exception(
                        "parse fail: xhs __INITIAL_STATE__ has noteData but missing note_id "
                        f"(可能被风控/需要登录态/链接过期). top_keys={keys}. "
                        "建议：在服务器/Docker 设置环境变量 XHS_COOKIE=浏览器登录后的小红书 Cookie"
                    )
            else:
                keys = list(json_data.keys())[:20] if isinstance(json_data, dict) else []
                raise Exception(
                    "parse fail: missing `note` in __INITIAL_STATE__ (可能被风控/返回结构变化). "
                    f"top_keys={keys}"
                )
        else:
            note_id = note_block.get("currentNoteId") or note_id_hint
            # 验证返回：小红书的分享链接有有效期，过期后会返回 undefined
            if not note_id or note_id == "undefined":
                raise Exception("parse fail: note id in response is empty/undefined (链接可能过期)")

            detail_map = note_block.get("noteDetailMap") or {}
            node = (detail_map.get(note_id) or {}).get("note") if isinstance(detail_map, dict) else None
            if not isinstance(node, dict):
                raise Exception("parse fail: missing noteDetailMap[note_id].note (返回结构变化/被拦截)")
            data = node

        # if we reached here, `data` should be a dict (either from note or noteData)
        if not isinstance(data, dict):
            raise Exception("parse fail: unable to locate note data (可能被风控/返回结构变化)")

        # 视频地址
        video_url = ""
        h264_data = (
            data.get("video", {}).get("media", {}).get("stream", {}).get("h264", [])
        )
        if len(h264_data) > 0:
            video_url = h264_data[0].get("masterUrl", "")

        # 获取图集图片地址
        images = []
        if len(video_url) <= 0:
            for img_item in data.get("imageList", []) or []:
                # 个别图片有水印, 替换图片域名
                url_default = img_item.get("urlDefault", "")
                if not url_default:
                    continue
                image_id = url_default.split("/")[-1].split("!")[0]
                # 如果链接中带有 spectrum/ , 替换域名时需要带上
                spectrum_str = (
                    "spectrum/" if "spectrum" in url_default else ""
                )
                new_url = (
                    "https://ci.xiaohongshu.com/notes_pre_post/"
                    + f"{spectrum_str}{image_id}"
                    + "?imageView2/format/jpg"
                )
                img_info = ImgInfo(url=new_url)
                # 如果原图片网址中没有 notes_pre_post 关键字，不支持替换域名，使用原域名
                if "notes_pre_post" not in url_default:
                    img_info.url = url_default
                # 是否有 livephoto 视频地址
                if img_item.get("livePhoto", False) and (
                    h264_data := img_item.get("stream", {}).get("h264", [])
                ):
                    img_info.live_photo_url = h264_data[0]["masterUrl"]
                images.append(img_info)

        video_info = VideoInfo(
            video_url=video_url,
            cover_url=(data.get("imageList", [{}])[0] or {}).get("urlDefault", ""),
            title=data.get("title", ""),
            images=images,
            author=VideoAuthor(
                uid=str((data.get("user") or {}).get("userId", "")),
                name=(data.get("user") or {}).get("nickname", ""),
                avatar=(data.get("user") or {}).get("avatar", ""),
            ),
        )
        return video_info

    async def parse_video_id(self, video_id: str) -> VideoInfo:
        raise NotImplementedError("小红书暂不支持直接解析视频ID")
