# Workflow Checklist

## Scope

Apply this checklist when changes touch any of:

- `src/tools/registry.ts`
- `src/utils/cnc/calculator-engine.ts`
- `src/components/tools/GenericCalculator.tsx`
- `src/components/tools/DynamicDiagram.tsx`
- `src/content/tools/<lang>/*.md`

## File Responsibilities

### `registry.ts`

- Keep every `slug` unique.
- Keep `calculatorId` aligned with engine definitions.
- Keep category accurate for discovery and content generation.

### `calculator-engine.ts`

- Keep `fields` and `results` minimal and required.
- Keep validation deterministic and user-facing.
- Keep every output bound to explicit formula logic.

### `DynamicDiagram.tsx`

- Keep one explicit `case` per `calculatorId` in `GeometryPane`.
- Keep generic mappings explicit in `GENERIC_DIAGRAM_CONFIG`.
- Keep diagram behavior linked to runtime values.

### `src/content/tools/*`

- Keep text tied to real tool semantics.
- Avoid repeated template paragraphs.
- Keep locale structure consistent.
- Use LLM-based translation, not word-by-word dictionary output.
- Localize related-tool link labels to localized tool titles.

## Quality Gates

1. `python ".../audit_tool_standard.py" --repo "<repo>"`
2. `npm run build`
3. `npm test`
4. Optional dist gate:
   - `python ".../audit_tool_standard.py" --repo "<repo>" --check-dist`
5. Localization residue quick checks:
   - Search non-`en` locales for English scaffold headings.
   - Search non-`en` locales for raw slug labels in related links.

## Definition of Done

- No missing calculator cases.
- No missing generic mappings.
- No missing localized tool files.
- No English scaffold heading residue in non-`en` locale files.
- Related tools link text is localized (not raw slug IDs).
- No fallback diagram messages in built pages.
- Build and tests are green.
