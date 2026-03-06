#!/usr/bin/env python3
"""Shared GitHub helpers for skill install scripts."""

from __future__ import annotations

import os
import urllib.request


def github_api_base() -> str:
    """Return the GitHub API base URL.

    Override with CODEX_GITHUB_API_BASE for mirrors/enterprise.
    Example: CODEX_GITHUB_API_BASE=https://github.company.local/api/v3
    """
    return os.environ.get("CODEX_GITHUB_API_BASE", "https://api.github.com").rstrip("/")


def github_base() -> str:
    """Return the GitHub web base URL.

    Override with CODEX_GITHUB_BASE for mirrors/enterprise.
    Example: CODEX_GITHUB_BASE=https://github.company.local
    """
    return os.environ.get("CODEX_GITHUB_BASE", "https://github.com").rstrip("/")


def codeload_base() -> str:
    """Return the GitHub codeload (zip download) base URL.

    Override with CODEX_CODELOAD_BASE for mirrors.
    Example: CODEX_CODELOAD_BASE=https://codeload.company.local
    Defaults to codeload.github.com, or if CODEX_GITHUB_BASE is set,
    derives from it by substituting the host with 'codeload.{host}'.
    """
    explicit = os.environ.get("CODEX_CODELOAD_BASE")
    if explicit:
        return explicit.rstrip("/")
    base = os.environ.get("CODEX_GITHUB_BASE")
    if base:
        import urllib.parse
        parsed = urllib.parse.urlparse(base.rstrip("/"))
        return f"{parsed.scheme}://codeload.{parsed.hostname}"
    return "https://codeload.github.com"


def github_request(url: str, user_agent: str) -> bytes:
    headers = {"User-Agent": user_agent}
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"token {token}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req) as resp:
        return resp.read()


def github_api_contents_url(repo: str, path: str, ref: str) -> str:
    return f"{github_api_base()}/repos/{repo}/contents/{path}?ref={ref}"
