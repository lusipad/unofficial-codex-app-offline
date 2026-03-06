---
name: cnc-tool-standardizer
description: Standardize AI CNC tool development and refactoring across calculator logic, diagram implementation, multilingual content generation, and acceptance gates. Use when adding or updating any tool that touches `registry.ts`, `calculator-engine.ts`, `DynamicDiagram.tsx`, or `src/content/tools/*`, especially when every tool must have a matching diagram and all locales must stay in sync.
---

# CNC Tool Standardizer

## Overview

Run a fixed four-stage pipeline:

1. Define tool schema and calculation logic.
2. Implement per-tool diagram routing.
3. Regenerate base content and run LLM localization.
4. Run audit, build, and tests.

Favor simple and verifiable changes. Avoid speculative abstractions.

## Quick Decision

- Add a new tool: update definition, rendering path, content, and validation.
- Refactor an existing tool: preserve IO semantics first, then improve diagram/content.
- Content-only update: regenerate locales and still run consistency gates.

## Standard Workflow

### 1) Lock scope

1. Read `src/tools/registry.ts` for `slug`, category, and `calculatorId`.
2. Read `src/utils/cnc/calculator-engine.ts` for `fields`, `results`, `calculate`, and `validate`.
3. Read `src/components/tools/GenericCalculator.tsx` and `src/components/tools/DynamicDiagram.tsx` for rendering flow.

### 2) Implement tool definition

1. Keep `fields` and `results` minimal and required.
2. Keep `calculatorId` unique and aligned between registry and engine.
3. Remove dead inputs/outputs that are not used by logic or rendering.

### 3) Implement diagrams (hard requirement)

1. Provide a diagram path for every tool.
2. Add one explicit `case` per `calculatorId` in `GeometryPane`.
3. Keep generic path explicit in `GENERIC_DIAGRAM_CONFIG` (auditable 1:1 mapping).
4. Ensure diagram changes with inputs or outputs (geometry, trend, risk, or status).

### 4) Regenerate localized content (LLM required)

1. Run `npm run expand:tools-content:long`.
   - This refreshes `en` + `zh` source content and geometry SVGs.
2. Run LLM localization for `ja/ko/de/es/pt/tr/vi`:
   - **API path (preferred when key exists):**
     - `python scripts/translate-tool-content.py --langs "ja,ko,de,es,pt,tr,vi"`
   - **No-API path (must use Codex multi-agent):**
     - Spawn one worker per locale; each worker owns exactly one directory:
       - `src/content/tools/ja/*.md`
       - `src/content/tools/ko/*.md`
       - `src/content/tools/de/*.md`
       - `src/content/tools/es/*.md`
       - `src/content/tools/pt/*.md`
       - `src/content/tools/tr/*.md`
       - `src/content/tools/vi/*.md`
     - Each worker translates from matching `src/content/tools/en/*.md`, preserving Markdown/frontmatter structure.
3. If geometry pages are involved, verify `public/images/tools/geometry/*.svg` exists.
4. Keep content tied to actual input/output semantics, not generic filler paragraphs.

### 5) Run quality gates

Run in order:

1. `python "C:/Users/lus/.codex/skills/cnc-tool-standardizer/scripts/audit_tool_standard.py" --repo "<repo-path>"`
2. `npm run build`
3. `npm test`
4. Optional built-page gate:
   - `python "C:/Users/lus/.codex/skills/cnc-tool-standardizer/scripts/audit_tool_standard.py" --repo "<repo-path>" --check-dist`

## Delivery Checklist

- `GenericCalculatorId` is fully covered by `GeometryPane` cases.
- `GENERIC_DIAGRAM_CONFIG` covers all generic calculator IDs.
- Localized tool files exist for all slugs and all supported languages.
- Non-`en` locales do not keep English scaffold headings (e.g., `Tool role and boundaries`).
- Related-tool link labels are localized titles, not raw slugs.
- Built pages do not show fallback diagram text.
- Build and test pass.

## Common Regressions

- Diagram missing: check `calculatorId` mismatch across registry, engine, and diagram switch.
- Locale drift: rerun content expansion and verify target language files were written.
- Build failure: fix type and mapping issues first, then style/content.

## Resources

- File responsibilities and done criteria: `references/workflow-checklist.md`
- Automated audit gate: `scripts/audit_tool_standard.py`
