import re

import httpx
import yaml

from .base import BaseParser, ImgInfo, VideoAuthor, VideoInfo
from utils.user_agent import get_user_agent


class RedBook(BaseParser):
    """
    小红书
    """

    async def parse_share_url(self, share_url: str) -> VideoInfo:
        headers = {
            # Prefer mobile-ish UA; xhs often serves "undefined" state for desktop/bot traffic.
            "User-Agent": get_user_agent("ios"),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        }
        async with httpx.AsyncClient(follow_redirects=True) as client:
            response = await client.get(share_url, headers=headers)
            response.raise_for_status()

        pattern = re.compile(
            pattern=r"window\.__INITIAL_STATE__\s*=\s*(.*?)</script>",
            flags=re.DOTALL,
        )
        find_res = pattern.search(response.text)

        if not find_res or not find_res.group(1):
            raise ValueError("parse video json info from html fail")

        json_data = yaml.safe_load(find_res.group(1)) or {}

        # NOTE: On some server IPs / environments, XHS may return an "anti-bot" state without `note`.
        # Avoid KeyError and return an actionable message instead.
        note_block = json_data.get("note") if isinstance(json_data, dict) else None
        if not isinstance(note_block, dict):
            keys = list(json_data.keys())[:20] if isinstance(json_data, dict) else []
            raise Exception(
                "parse fail: missing `note` in __INITIAL_STATE__ (可能被风控/返回结构变化). "
                f"top_keys={keys}"
            )

        note_id = note_block.get("currentNoteId")
        # 验证返回：小红书的分享链接有有效期，过期后会返回 undefined
        if not note_id or note_id == "undefined":
            raise Exception("parse fail: note id in response is empty/undefined (链接可能过期)")

        detail_map = note_block.get("noteDetailMap") or {}
        node = (detail_map.get(note_id) or {}).get("note") if isinstance(detail_map, dict) else None
        if not isinstance(node, dict):
            raise Exception("parse fail: missing noteDetailMap[note_id].note (返回结构变化/被拦截)")
        data = node

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
