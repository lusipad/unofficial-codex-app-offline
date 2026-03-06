#!/usr/bin/env python3
"""List skills from a GitHub repo path."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error

from github_utils import github_api_contents_url, github_request

DEFAULT_REPO = "openai/skills"
DEFAULT_PATH = "skills/.curated"
DEFAULT_REF = "main"


class ListError(Exception):
    pass


class Args(argparse.Namespace):
    repo: str
    path: str
    ref: str
    format: str
    source_dir: str | None


def _request(url: str) -> bytes:
    return github_request(url, "codex-skill-list")


def _codex_home() -> str:
    return os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex"))


def _installed_skills() -> set[str]:
    root = os.path.join(_codex_home(), "skills")
    if not os.path.isdir(root):
        return set()
    entries = set()
    for name in os.listdir(root):
        path = os.path.join(root, name)
        if os.path.isdir(path):
            entries.add(name)
    return entries


def _list_local_skills() -> list[str]:
    """List non-system skills available locally in CODEX_HOME/skills."""
    root = os.path.join(_codex_home(), "skills")
    if not os.path.isdir(root):
        return []
    entries = []
    for name in os.listdir(root):
        if name.startswith("."):
            continue
        path = os.path.join(root, name)
        if os.path.isdir(path):
            entries.append(name)
    return sorted(entries)


def _list_skills_from_dir(source_dir: str) -> list[str]:
    """List skill directories from a local path (LAN share or local folder)."""
    if not os.path.isdir(source_dir):
        raise ListError(f"Source directory not found: {source_dir}")
    entries = []
    for name in os.listdir(source_dir):
        if name.startswith("."):
            continue
        path = os.path.join(source_dir, name)
        if os.path.isdir(path):
            entries.append(name)
    return sorted(entries)


def _list_skills(repo: str, path: str, ref: str) -> list[str]:
    api_url = github_api_contents_url(repo, path, ref)
    try:
        payload = _request(api_url)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise ListError(
                "Skills path not found: "
                f"https://github.com/{repo}/tree/{ref}/{path}"
            ) from exc
        raise ListError(f"Failed to fetch skills: HTTP {exc.code}") from exc
    data = json.loads(payload.decode("utf-8"))
    if not isinstance(data, list):
        raise ListError("Unexpected skills listing response.")
    skills = [item["name"] for item in data if item.get("type") == "dir"]
    return sorted(skills)


def _parse_args(argv: list[str]) -> Args:
    parser = argparse.ArgumentParser(description="List skills.")
    parser.add_argument("--repo", default=DEFAULT_REPO)
    parser.add_argument(
        "--path",
        default=DEFAULT_PATH,
        help="Repo path to list (default: skills/.curated)",
    )
    parser.add_argument("--ref", default=DEFAULT_REF)
    parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format",
    )
    parser.add_argument(
        "--source-dir",
        dest="source_dir",
        help="Local directory containing skills (bypasses GitHub, e.g. a LAN share)",
    )
    return parser.parse_args(argv, namespace=Args())


def main(argv: list[str]) -> int:
    args = _parse_args(argv)
    # CODEX_SKILL_SOURCE_DIR: local directory used as skill source instead of
    # GitHub.  Set automatically by bootstrap when running from an offline
    # package; can also be set manually in skill-installer.env.
    if not args.source_dir:
        args.source_dir = os.environ.get("CODEX_SKILL_SOURCE_DIR") or None
    offline_fallback = False
    source_label: str | None = None
    try:
        if args.source_dir:
            skills = _list_skills_from_dir(args.source_dir)
            source_label = args.source_dir
        else:
            try:
                skills = _list_skills(args.repo, args.path, args.ref)
            except urllib.error.URLError as exc:
                print(
                    f"Warning: Cannot reach GitHub ({exc}). Showing locally bundled skills.",
                    file=sys.stderr,
                )
                skills = _list_local_skills()
                offline_fallback = True
        installed = _installed_skills()
        if args.format == "json":
            payload = [
                {"name": name, "installed": name in installed} for name in skills
            ]
            print(json.dumps(payload))
        else:
            if source_label:
                print(f"Skills from {source_label}:\n")
            elif offline_fallback:
                print("(Offline mode: GitHub unavailable, showing locally bundled skills)\n")
            for idx, name in enumerate(skills, start=1):
                suffix = " (already installed)" if name in installed else ""
                print(f"{idx}. {name}{suffix}")
        return 0
    except ListError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
