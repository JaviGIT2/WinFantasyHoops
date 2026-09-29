"""Polite, cached page fetcher for basketball-reference.com.

Sports Reference blocks clients that exceed 20 requests/minute, so requests are
spaced (default 4 s ≈ 15/min) and every *parsed* page is cached on disk as
``{"fetchedAt": <ms>, "data": ...}``. Re-running only hits the network for pages
that are missing or whose TTL expired, so long fetches resume where they stopped.
"""
from __future__ import annotations

import json
import math
import os
import re
import time
from pathlib import Path
from typing import Any, Callable

import requests

BASE = "https://www.basketball-reference.com"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
CACHE_DIR = Path(os.environ.get("WFH_CACHE", "data-cache")).resolve()
PAGE_DIR = CACHE_DIR / "pages"
HOUR = 3600.0


class RateLimited(Exception):
    pass


class Fetcher:
    def __init__(self, min_interval: float = 4.0):
        self.min_interval = min_interval
        self.last = 0.0
        self.requests = 0
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": UA, "Accept": "text/html,application/xhtml+xml"})

    def html(self, url_path: str) -> str | None:
        for attempt in range(3):
            wait = self.last + self.min_interval - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self.last = time.monotonic()
            self.requests += 1
            try:
                res = self.session.get(BASE + url_path, timeout=45)
            except requests.RequestException:
                if attempt == 2:
                    raise
                time.sleep(5 * (attempt + 1))
                continue
            if res.status_code == 404:
                return None
            if res.status_code == 429:
                raise RateLimited(
                    f"basketball-reference rate limit hit on {url_path}. Wait ~1 hour, then re-run; cached pages are kept."
                )
            if res.status_code >= 500:
                time.sleep(5 * (attempt + 1))
                continue
            res.raise_for_status()
            res.encoding = "utf-8"
            return res.text
        raise RuntimeError(f"Failed to fetch {url_path}")


def cache_file(url_path: str) -> Path:
    key = re.sub(r"[^a-zA-Z0-9._-]+", "_", url_path.lstrip("/"))
    return PAGE_DIR / f"{key}.json"


def cached_page(fetcher: Fetcher, url_path: str, parse: Callable[[str], Any], ttl_hours: float = math.inf) -> tuple[Any, bool]:
    """Fetch ``url_path``, parse it and cache the parsed result. Returns (data, from_cache).

    A 404 is cached as ``None`` so absent pages aren't re-requested until the TTL expires.
    """
    file = cache_file(url_path)
    if file.exists():
        entry = json.loads(file.read_text(encoding="utf-8"))
        if time.time() * 1000 - entry["fetchedAt"] < ttl_hours * HOUR * 1000:
            return entry["data"], True
    html = fetcher.html(url_path)
    data = None if html is None else parse(html)
    PAGE_DIR.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps({"fetchedAt": int(time.time() * 1000), "data": data}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return data, False


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def read_json(path: Path, default: Any = None) -> Any:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default
