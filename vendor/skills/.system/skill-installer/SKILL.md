---
name: skill-installer
description: Install Codex skills into $CODEX_HOME/skills from a curated list, a GitHub repo path, or a local directory. Use when a user asks to list installable skills, install a curated skill, or install a skill from another repo or local path (including LAN shares and intranet environments).
metadata:
  short-description: Install curated skills from openai/skills, other repos, or local directories
---

# Skill Installer

Helps install skills. By default these are from https://github.com/openai/skills/tree/main/skills/.curated, but users can also provide other locations — including local directories and LAN shares. Experimental skills live in https://github.com/openai/skills/tree/main/skills/.experimental and can be installed the same way.

Use the helper scripts based on the task:
- List skills when the user asks what is available, or if the user uses this skill without specifying what to do. Default listing is `.curated`, but you can pass `--path skills/.experimental` when they ask about experimental skills.
- Install from the curated list when the user provides a skill name.
- Install from another repo when the user provides a GitHub repo/path (including private repos).
- Install from a local directory or LAN share when the user provides a local path.

Install skills with the helper scripts.

## Communication

When listing skills, output approximately as follows, depending on the context of the user's request. If they ask about experimental skills, list from `.experimental` instead of `.curated` and label the source accordingly:
"""
Skills from {repo or directory}:
1. skill-1
2. skill-2 (already installed)
3. ...
Which ones would you like installed?
"""

After installing a skill, tell the user: "Restart Codex to pick up new skills."

## Scripts

All of these scripts use network, so when running in the sandbox, request escalation when running them. Local directory operations do not require network access.

- `scripts/list-skills.py` (prints skills list with installed annotations)
- `scripts/list-skills.py --format json`
- Example (experimental list): `scripts/list-skills.py --path skills/.experimental`
- Example (local/LAN directory): `scripts/list-skills.py --source-dir C:\skills` or `scripts/list-skills.py --source-dir \\server\skills`
- `scripts/install-skill-from-github.py --repo <owner>/<repo> --path <path/to/skill> [<path/to/skill> ...]`
- `scripts/install-skill-from-github.py --url https://github.com/<owner>/<repo>/tree/<ref>/<path>`
- Example (experimental skill): `scripts/install-skill-from-github.py --repo openai/skills --path skills/.experimental/<skill-name>`
- Example (local skill directory): `scripts/install-skill-from-github.py --local-dir C:\skills\my-skill`
- Example (skill from local repo/share): `scripts/install-skill-from-github.py --local-dir \\server\skills --path my-skill`

## Behavior and Options

- Defaults to direct download for public GitHub repos.
- If download fails with auth/permission errors, falls back to git sparse checkout.
- Aborts if the destination skill directory already exists.
- Installs into `$CODEX_HOME/skills/<skill-name>` (defaults to `~/.codex/skills`).
- Multiple `--path` values install multiple skills in one run, each named from the path basename unless `--name` is supplied.
- Options: `--ref <ref>` (default `main`), `--dest <path>`, `--method auto|download|git`.
- `--local-dir <path>`: install from a local directory or LAN share instead of GitHub (no network needed).
- `--source-dir <path>`: list skills from a local directory or LAN share instead of GitHub.

## Notes

- Curated listing is fetched from `https://github.com/openai/skills/tree/main/skills/.curated` via the GitHub API. If GitHub is unreachable (e.g., offline or intranet environment), the script automatically falls back to listing locally bundled skills from `$CODEX_HOME/skills`.
- Private GitHub repos can be accessed via existing git credentials or optional `GITHUB_TOKEN`/`GH_TOKEN` for download.
- Git fallback tries HTTPS first, then SSH.
- The skills at https://github.com/openai/skills/tree/main/skills/.system are preinstalled, so no need to help users install those. If they ask, just explain this. If they insist, you can download and overwrite.
- Installed annotations come from `$CODEX_HOME/skills`.

## Mirror / Intranet Configuration

Set environment variables to redirect all GitHub requests to a local mirror:

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_GITHUB_BASE` | `https://github.com` | Web URL base (git clone, URL parsing) |
| `CODEX_GITHUB_API_BASE` | `https://api.github.com` | REST API base (listing, metadata) |
| `CODEX_CODELOAD_BASE` | derived from `CODEX_GITHUB_BASE` | Zip download base |

If only `CODEX_GITHUB_BASE` is set, `CODEX_CODELOAD_BASE` is automatically derived as
`{scheme}://codeload.{host}` (matching GitHub's subdomain layout).

For GitHub Enterprise, set `CODEX_GITHUB_API_BASE=https://GHE_HOST/api/v3`.

Example (simple mirror, same subdomain structure as GitHub):
```
CODEX_GITHUB_BASE=https://github.company.local
CODEX_GITHUB_API_BASE=https://api.github.company.local
```

Example (GitHub Enterprise):
```
CODEX_GITHUB_BASE=https://ghe.company.local
CODEX_GITHUB_API_BASE=https://ghe.company.local/api/v3
CODEX_CODELOAD_BASE=https://ghe.company.local/codeload
```
