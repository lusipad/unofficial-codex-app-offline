#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

LANGS = ["en", "zh", "ja", "ko", "de", "es", "pt", "tr", "vi"]
EN_SCAFFOLD_HEADINGS = [
    "## Tool role and boundaries",
    "## Fast baseline workflow",
    "## Input strategy",
    "## Output interpretation",
    "## Typical failure modes and fixes",
    "## Final recommendation",
]


@dataclass
class CheckResult:
    name: str
    ok: bool
    details: dict


def read_text(path: Path) -> str:
    if not path.exists():
        raise FileNotFoundError(f"Missing file: {path}")
    return path.read_text(encoding="utf-8")


def extract_generic_calculator_ids(engine_text: str) -> list[str]:
    match = re.search(r"export type GenericCalculatorId\s*=\s*(.*?)\n\nexport interface", engine_text, re.S)
    if not match:
        raise ValueError("Cannot parse GenericCalculatorId union")
    return re.findall(r"'([^']+)'", match.group(1))


def extract_tool_registry_items(registry_text: str) -> list[tuple[str, str]]:
    match = re.search(r"export const TOOL_REGISTRY:\s*ToolDefinition\[\]\s*=\s*\[(.*?)]\s*;", registry_text, re.S)
    if not match:
        raise ValueError("Cannot parse TOOL_REGISTRY")
    block = match.group(1)
    pattern = re.compile(r"\{\s*slug:\s*'([^']+)'.*?category:\s*'([^']+)'.*?\n\s*\},", re.S)
    return pattern.findall(block)


def extract_specialized_ids(diagram_text: str) -> list[str]:
    match = re.search(r"type SpecializedDiagramCalculatorId\s*=\s*(.*?);\n\n", diagram_text, re.S)
    if not match:
        raise ValueError("Cannot parse SpecializedDiagramCalculatorId")
    return re.findall(r"'([^']+)'", match.group(1))


def extract_generic_config_ids(diagram_text: str) -> list[str]:
    match = re.search(r"const GENERIC_DIAGRAM_CONFIG:\s*Record<[^>]+>\s*=\s*\{(.*?)\n\};", diagram_text, re.S)
    if not match:
        raise ValueError("Cannot parse GENERIC_DIAGRAM_CONFIG")
    return re.findall(r"\n\s+([a-zA-Z0-9]+):\s*\{", match.group(1))


def extract_geometry_pane_cases(diagram_text: str) -> tuple[list[str], bool]:
    match = re.search(r"function GeometryPane\(\{.*?\n\}\n\nexport default function DynamicDiagram", diagram_text, re.S)
    if not match:
        raise ValueError("Cannot parse GeometryPane block")
    block = match.group(0)
    cases = re.findall(r"case '([^']+)':", block)
    has_default = re.search(r"\bdefault\s*:", block) is not None
    return cases, has_default


def check_geometry_mapping(repo: Path) -> CheckResult:
    engine_text = read_text(repo / "src/utils/cnc/calculator-engine.ts")
    diagram_text = read_text(repo / "src/components/tools/DynamicDiagram.tsx")

    engine_ids = set(extract_generic_calculator_ids(engine_text))
    specialized_ids = set(extract_specialized_ids(diagram_text))
    generic_config_ids = set(extract_generic_config_ids(diagram_text))
    case_ids, has_default = extract_geometry_pane_cases(diagram_text)
    case_ids_set = set(case_ids)

    expected_generic_ids = engine_ids - specialized_ids

    details = {
        "generic_calculator_ids": len(engine_ids),
        "specialized_ids": sorted(specialized_ids),
        "geometry_cases": len(case_ids),
        "generic_config_entries": len(generic_config_ids),
        "missing_cases": sorted(engine_ids - case_ids_set),
        "extra_cases": sorted(case_ids_set - engine_ids),
        "missing_generic_config": sorted(expected_generic_ids - generic_config_ids),
        "extra_generic_config": sorted(generic_config_ids - expected_generic_ids),
        "specialized_not_in_engine": sorted(specialized_ids - engine_ids),
        "has_default_in_geometry_pane": has_default,
    }

    ok = (
        not details["missing_cases"]
        and not details["extra_cases"]
        and not details["missing_generic_config"]
        and not details["extra_generic_config"]
        and not details["specialized_not_in_engine"]
        and not has_default
    )
    return CheckResult(name="geometry-mapping", ok=ok, details=details)


def chunked(items: Iterable[str], size: int = 12) -> list[list[str]]:
    items_list = list(items)
    return [items_list[i:i + size] for i in range(0, len(items_list), size)]


def check_localized_content(repo: Path) -> CheckResult:
    registry_text = read_text(repo / "src/tools/registry.ts")
    tools = extract_tool_registry_items(registry_text)
    slugs = sorted({slug for slug, _ in tools})

    missing_files: list[str] = []
    for lang in LANGS:
        for slug in slugs:
            path = repo / "src/content/tools" / lang / f"{slug}.md"
            if not path.exists():
                missing_files.append(str(path))

    details = {
        "languages": LANGS,
        "tool_count": len(slugs),
        "expected_files": len(LANGS) * len(slugs),
        "missing_files_count": len(missing_files),
        "missing_files_preview": missing_files[:30],
    }

    return CheckResult(name="localized-content", ok=len(missing_files) == 0, details=details)


def check_geometry_assets(repo: Path) -> CheckResult:
    registry_text = read_text(repo / "src/tools/registry.ts")
    tools = extract_tool_registry_items(registry_text)
    geometry_slugs = sorted({slug for slug, category in tools if category == "geometry-math"})

    missing_svgs: list[str] = []
    for slug in geometry_slugs:
        svg = repo / "public/images/tools/geometry" / f"{slug}.svg"
        if not svg.exists():
            missing_svgs.append(str(svg))

    details = {
        "geometry_tool_count": len(geometry_slugs),
        "missing_svg_count": len(missing_svgs),
        "missing_svg_preview": missing_svgs[:30],
    }

    return CheckResult(name="geometry-assets", ok=len(missing_svgs) == 0, details=details)


def check_localization_quality(repo: Path) -> CheckResult:
    en_heading_hits: list[str] = []
    raw_slug_link_hits: list[str] = []

    for lang in LANGS:
        if lang == "en":
            continue
        lang_dir = repo / "src/content/tools" / lang
        if not lang_dir.exists():
            continue

        slug_link_pattern = re.compile(rf"^\s*-\s+\[([a-z0-9-]+)\]\(/{lang}/tools/([a-z0-9-]+)/\)\s*$", re.M)
        for path in sorted(lang_dir.glob("*.md")):
            text = path.read_text(encoding="utf-8")

            for heading in EN_SCAFFOLD_HEADINGS:
                if heading in text:
                    en_heading_hits.append(f"{path}:{heading}")

            for match in slug_link_pattern.finditer(text):
                label = match.group(1)
                slug = match.group(2)
                if label == slug:
                    raw_slug_link_hits.append(str(path))
                    break

    details = {
        "english_scaffold_heading_hits_count": len(en_heading_hits),
        "english_scaffold_heading_hits_preview": en_heading_hits[:40],
        "raw_slug_related_link_hits_count": len(raw_slug_link_hits),
        "raw_slug_related_link_hits_preview": raw_slug_link_hits[:40],
    }
    ok = not en_heading_hits and not raw_slug_link_hits
    return CheckResult(name="localization-quality", ok=ok, details=details)


def check_dist_pages(repo: Path) -> CheckResult:
    registry_text = read_text(repo / "src/tools/registry.ts")
    tools = extract_tool_registry_items(registry_text)
    slugs = sorted({slug for slug, _ in tools})

    missing_pages: list[str] = []
    missing_diagram_title: list[str] = []
    fallback_hits: list[str] = []

    for lang in LANGS:
        marker = "参数联动图示" if lang == "zh" else "Linked Parameter Diagram"
        fallback_text = "当前计算器暂无专用几何图" if lang == "zh" else "No dedicated geometry diagram for this calculator."
        for slug in slugs:
            page = repo / "dist" / lang / "tools" / slug / "index.html"
            if not page.exists():
                missing_pages.append(str(page))
                continue
            html = page.read_text(encoding="utf-8")
            if marker not in html:
                missing_diagram_title.append(str(page))
            if fallback_text in html:
                fallback_hits.append(str(page))

    details = {
        "missing_pages_count": len(missing_pages),
        "missing_pages_preview": missing_pages[:20],
        "missing_diagram_title_count": len(missing_diagram_title),
        "missing_diagram_title_preview": missing_diagram_title[:20],
        "fallback_hits_count": len(fallback_hits),
        "fallback_hits_preview": fallback_hits[:20],
    }

    ok = not missing_pages and not missing_diagram_title and not fallback_hits
    return CheckResult(name="dist-pages", ok=ok, details=details)


def print_human(results: list[CheckResult]) -> None:
    for result in results:
        status = "PASS" if result.ok else "FAIL"
        print(f"[{status}] {result.name}")
        for key, value in result.details.items():
            if isinstance(value, list):
                if value:
                    print(f"  - {key}: {len(value)} items")
                    for row in chunked([str(v) for v in value], 4):
                        print(f"    * {' | '.join(row)}")
                else:
                    print(f"  - {key}: []")
            else:
                print(f"  - {key}: {value}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit AIxCNC tool standardization gates")
    parser.add_argument("--repo", default=".", help="Repository root path")
    parser.add_argument("--check-dist", action="store_true", help="Validate built dist pages")
    parser.add_argument("--json", action="store_true", help="Print JSON output")
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    if not repo.exists():
        print(f"Repository path does not exist: {repo}", file=sys.stderr)
        return 2

    try:
        results = [
            check_geometry_mapping(repo),
            check_localized_content(repo),
            check_geometry_assets(repo),
            check_localization_quality(repo),
        ]
        if args.check_dist:
            results.append(check_dist_pages(repo))
    except (FileNotFoundError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 2

    ok = all(item.ok for item in results)

    if args.json:
        payload = {
            "repo": str(repo),
            "ok": ok,
            "checks": [
                {
                    "name": item.name,
                    "ok": item.ok,
                    "details": item.details,
                }
                for item in results
            ],
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print_human(results)
        print(f"\nOverall: {'PASS' if ok else 'FAIL'}")

    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
