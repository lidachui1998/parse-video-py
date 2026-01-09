import os
import re
import secrets
from ipaddress import ip_address
from urllib.parse import urlparse

import httpx
import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import HTMLResponse, PlainTextResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.background import BackgroundTask
from starlette.responses import StreamingResponse

from utils.user_agent import get_user_agent
try:
    # Optional dependency (MCP support). Allow the web UI to run even if it's missing.
    from fastapi_mcp import FastApiMCP  # type: ignore
except ImportError:  # pragma: no cover
    FastApiMCP = None  # type: ignore

app = FastAPI()

if FastApiMCP is not None:
    mcp = FastApiMCP(app)
    mcp.mount_http()
else:
    mcp = None

templates = Jinja2Templates(directory="templates")

# static assets (css/js/icons)
app.mount("/static", StaticFiles(directory="static"), name="static")


def get_auth_dependency() -> list[Depends]:
    """
    根据环境变量动态返回 Basic Auth 依赖项
    - 如果设置了 USERNAME 和 PASSWORD，返回验证函数
    - 如果未设置，返回一个直接返回 None 的 Depends
    """
    basic_auth_username = os.getenv("PARSE_VIDEO_USERNAME")
    basic_auth_password = os.getenv("PARSE_VIDEO_PASSWORD")

    if not (basic_auth_username and basic_auth_password):
        return []  # 返回包含Depends实例的列表

    security = HTTPBasic()

    def verify_credentials(credentials: HTTPBasicCredentials = Depends(security)):
        # 验证凭据
        correct_username = secrets.compare_digest(
            credentials.username, basic_auth_username
        )
        correct_password = secrets.compare_digest(
            credentials.password, basic_auth_password
        )
        if not (correct_username and correct_password):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Incorrect username or password",
                headers={"WWW-Authenticate": "Basic"},
            )
        return credentials

    return [Depends(verify_credentials)]  # 返回封装好的 Depends


@app.get("/", response_class=HTMLResponse, dependencies=get_auth_dependency())
async def read_item(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "title": "parse-video-py",
        },
    )


def _is_unsafe_proxy_target(url: str) -> str | None:
    """
    Basic SSRF guard for /proxy. Returns error message if blocked, else None.
    - Blocks non-http(s)
    - Blocks localhost/loopback + private/link-local IP literals
    """
    try:
        u = urlparse(url)
    except Exception:
        return "invalid url"

    if u.scheme not in {"http", "https"}:
        return "only http/https are allowed"

    host = (u.hostname or "").lower()
    if not host:
        return "missing hostname"

    if host in {"localhost"} or host.endswith(".localhost"):
        return "localhost is not allowed"

    # If hostname is an IP literal, block unsafe ranges.
    try:
        ip = ip_address(host)
        if ip.is_loopback or ip.is_private or ip.is_link_local:
            return "private/loopback ip is not allowed"
    except ValueError:
        # domain name: allow (can't reliably resolve here without extra latency)
        pass

    return None


@app.get("/proxy", dependencies=get_auth_dependency())
async def proxy(url: str, request: Request, referer: str | None = None):
    """
    Stream remote content through this server.
    Purpose:
    - Fix <video> preview issues caused by anti-hotlink / Range requests.
    - Avoid CORS issues for in-browser image zip downloads.
    """
    blocked = _is_unsafe_proxy_target(url)
    if blocked:
        return PlainTextResponse(f"blocked: {blocked}", status_code=400)

    # Build headers for upstream request
    upstream_headers: dict[str, str] = {
        "User-Agent": get_user_agent("ios"),
    }
    if referer:
        upstream_headers["Referer"] = referer
    else:
        # default referer = origin of the target url
        u = urlparse(url)
        upstream_headers["Referer"] = f"{u.scheme}://{u.netloc}/"

    range_header = request.headers.get("range")
    if range_header:
        upstream_headers["Range"] = range_header

    client = httpx.AsyncClient(follow_redirects=True, timeout=30.0)
    req = client.build_request("GET", url, headers=upstream_headers)
    upstream = await client.send(req, stream=True)

    # Copy safe headers back to client
    passthrough = {}
    for k, v in upstream.headers.items():
        lk = k.lower()
        if lk in {
            "content-type",
            "content-length",
            "content-range",
            "accept-ranges",
            "last-modified",
            "etag",
            "cache-control",
        }:
            passthrough[k] = v

    async def _close():
        await upstream.aclose()
        await client.aclose()

    return StreamingResponse(
        upstream.aiter_bytes(),
        status_code=upstream.status_code,
        headers=passthrough,
        background=BackgroundTask(_close),
    )


@app.get("/video/share/url/parse", dependencies=get_auth_dependency())
async def share_url_parse(url: str):
    url_reg = re.compile(r"http[s]?:\/\/[\w.-]+[\w\/-]*[\w.-]*\??[\w=&:\-\+\%]*[/]*")
    video_share_url = url_reg.search(url).group()

    try:
        # Lazy import: allow UI to load even if optional parser deps aren't installed yet
        from parser import parse_video_share_url

        video_info = await parse_video_share_url(video_share_url)
        return {"code": 200, "msg": "解析成功", "data": video_info.__dict__}
    except ImportError as err:
        return {
            "code": 500,
            "msg": f"依赖未安装或不兼容（ImportError）：{err}. 请使用 Python 3.10-3.12 创建虚拟环境并执行 pip install -r requirements.txt",
        }
    except Exception as err:
        return {
            "code": 500,
            "msg": str(err),
        }


@app.get("/video/id/parse", dependencies=get_auth_dependency())
async def video_id_parse(source: str, video_id: str):
    try:
        # Lazy import: same reason as share_url_parse
        from parser import VideoSource, parse_video_id

        try:
            source_enum = VideoSource(source)  # by value (e.g. "douyin")
        except Exception:
            source_enum = VideoSource[source]  # by name (e.g. "DouYin")

        video_info = await parse_video_id(source_enum, video_id)
        return {"code": 200, "msg": "解析成功", "data": video_info.__dict__}
    except ImportError as err:
        return {
            "code": 500,
            "msg": f"依赖未安装或不兼容（ImportError）：{err}. 请使用 Python 3.10-3.12 创建虚拟环境并执行 pip install -r requirements.txt",
        }
    except Exception as err:
        return {
            "code": 500,
            "msg": str(err),
        }


if mcp is not None:
    mcp.setup_server()

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
