import os
import re
import secrets
from datetime import datetime, timezone
from ipaddress import ip_address
from urllib.parse import urlparse

import httpx
import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware
from starlette.background import BackgroundTask
from starlette.responses import StreamingResponse

from utils.user_agent import get_user_agent
from utils.auth_db import User, create_user, get_user_by_id, verify_user
from utils.history_db import delete_history_item, get_history_item, init_db, insert_history, list_history
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

@app.on_event("startup")
async def _startup():
    init_db()

# Session config
# - secret_key: use env var so restarts don't invalidate existing sessions
# - max_age: default 30 days
_secret = os.getenv("SESSION_SECRET_KEY") or os.getenv("PARSE_VIDEO_SECRET") or secrets.token_urlsafe(32)
_max_age = int(os.getenv("SESSION_MAX_AGE_SECONDS") or str(30 * 24 * 60 * 60))
app.add_middleware(
    SessionMiddleware,
    secret_key=_secret,
    same_site="lax",
    https_only=False,
    max_age=_max_age,
)


def get_current_user(request: Request) -> User | None:
    uid = request.session.get("user_id") if hasattr(request, "session") else None
    if not uid:
        return None
    try:
        return get_user_by_id(int(uid))
    except Exception:
        return None


def require_user(request: Request) -> User:
    u = get_current_user(request)
    if not u:
        raise HTTPException(status_code=401, detail="Login required")
    return u


@app.get("/", response_class=HTMLResponse)
async def read_item(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "title": "parse-video-py",
        },
    )


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="login.html",
        context={"title": "登录"},
    )


@app.post("/login")
async def login_action(request: Request):
    form = await request.form()
    username = str(form.get("username") or "").strip()
    password = str(form.get("password") or "")
    u = verify_user(username, password)
    if not u:
        return templates.TemplateResponse(
            request=request,
            name="login.html",
            context={"title": "登录", "error": "账号或密码不正确"},
            status_code=400,
        )
    request.session["user_id"] = u.id
    request.session["username"] = u.username
    return RedirectResponse(url="/", status_code=303)


@app.get("/register", response_class=HTMLResponse)
async def register_page(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="register.html",
        context={"title": "注册"},
    )


@app.post("/register")
async def register_action(request: Request):
    form = await request.form()
    username = str(form.get("username") or "").strip()
    password = str(form.get("password") or "")
    password2 = str(form.get("password2") or "")
    if password != password2:
        return templates.TemplateResponse(
            request=request,
            name="register.html",
            context={"title": "注册", "error": "两次密码不一致"},
            status_code=400,
        )
    try:
        created_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        u = create_user(username, password, created_at=created_at)
    except Exception as e:
        return templates.TemplateResponse(
            request=request,
            name="register.html",
            context={"title": "注册", "error": str(e)},
            status_code=400,
        )
    request.session["user_id"] = u.id
    request.session["username"] = u.username
    return RedirectResponse(url="/", status_code=303)


@app.get("/logout")
async def logout(request: Request):
    request.session.clear()
    return RedirectResponse(url="/", status_code=303)


@app.get("/api/me")
async def api_me(request: Request):
    u = get_current_user(request)
    if not u:
        return {"code": 401, "msg": "not logged in"}
    return {"code": 200, "msg": "ok", "data": {"id": u.id, "username": u.username}}


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


@app.get("/proxy")
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


@app.get("/api/history")
async def api_history_list(request: Request, limit: int = 50):
    u = require_user(request)
    items = list_history(user_id=u.id, limit=limit)
    return {"code": 200, "msg": "ok", "data": items}


@app.get("/api/history/{item_id}")
async def api_history_get(request: Request, item_id: int):
    u = require_user(request)
    item = get_history_item(user_id=u.id, item_id=item_id)
    if not item:
        return {"code": 404, "msg": "not found"}
    return {"code": 200, "msg": "ok", "data": item}


@app.delete("/api/history/{item_id}")
async def api_history_delete(request: Request, item_id: int):
    u = require_user(request)
    ok = delete_history_item(user_id=u.id, item_id=item_id)
    return {"code": 200 if ok else 404, "msg": "ok" if ok else "not found"}


@app.get("/video/share/url/parse")
async def share_url_parse(request: Request, url: str):
    url_reg = re.compile(r"http[s]?:\/\/[\w.-]+[\w\/-]*[\w.-]*\??[\w=&:\-\+\%]*[/]*")
    video_share_url = url_reg.search(url).group()

    try:
        # Lazy import: allow UI to load even if optional parser deps aren't installed yet
        from parser import parse_video_share_url

        video_info = await parse_video_share_url(video_share_url)
        data = jsonable_encoder(video_info)
        kind = "video" if data.get("video_url") else "images"
        title = data.get("title") or ""
        u = get_current_user(request)
        if u:
            insert_history(
                user_id=u.id,
                share_url=video_share_url,
                title=title,
                kind=kind,
                data=data,
            )
        return {"code": 200, "msg": "解析成功", "data": data}
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


@app.get("/video/id/parse")
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
