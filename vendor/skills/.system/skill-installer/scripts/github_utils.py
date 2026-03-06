#!/usr/bin/env python3
"""Shared GitHub helpers for skill install scripts."""

from __future__ import annotations

import os
import urllib.parse
import urllib.request


def _load_env_file() -> None:
    """Load skill-installer.env into os.environ (existing vars take priority).

    Searches in order:
      1. $CODEX_HOME/skill-installer.env        (user config)
      2. <skill-installer dir>/skill-installer.env  (portable / per-install config)
    """
    codex_home = os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex"))
    skill_dir = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
    candidates = [
        os.path.join(codex_home, "skill-installer.env"),
        os.path.join(skill_dir, "skill-installer.env"),
    ]
    for path in candidates:
        if os.path.isfile(path):
            _parse_env_file(path)
            break


def _parse_env_file(path: str) -> None:
    """Parse a KEY=VALUE file and set missing env vars (does not overwrite)."""
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
                value = value[1:-1]
            if key and key not in os.environ:
                os.environ[key] = value


# Load config file once at import time so all helpers see the values.
_load_env_file()


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
    If unset but CODEX_GITHUB_BASE is set, derives automatically as
    '{scheme}://codeload.{host}' (matching GitHub's own subdomain layout).
    """
    explicit = os.environ.get("CODEX_CODELOAD_BASE")
    if explicit:
        return explicit.rstrip("/")
    base = os.environ.get("CODEX_GITHUB_BASE")
    if base:
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
