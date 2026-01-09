from __future__ import annotations

from functools import lru_cache


_FALLBACK_UA = {
    "ios": (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    ),
    "android": (
        "Mozilla/5.0 (Linux; Android 14; Pixel 7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
    ),
    "windows": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
}


@lru_cache(maxsize=8)
def _get_fake_useragent(os_hint: str):
    import fake_useragent  # import lazily

    return fake_useragent.UserAgent(os=[os_hint])


def get_user_agent(os_hint: str = "ios") -> str:
    """
    Return a stable & fast User-Agent string.
    - Uses fake-useragent if available, but caches the UA generator per os_hint.
    - Falls back to hard-coded UA to avoid network/slowdowns.
    """
    os_hint = (os_hint or "ios").lower()
    if os_hint not in _FALLBACK_UA:
        os_hint = "ios"

    try:
        ua = _get_fake_useragent(os_hint).random
        return ua or _FALLBACK_UA[os_hint]
    except Exception:
        return _FALLBACK_UA[os_hint]

