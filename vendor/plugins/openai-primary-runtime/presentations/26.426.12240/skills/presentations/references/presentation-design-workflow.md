# Presentation Design Workflow

This is the compact design and QA standard for the Presentations skill. It preserves the evaluated compose-first workflow while keeping operational details in scripts.

## Orientation

Before writing code, capture:

```text
requestClass, topic, audience, decisionToUnlock, outcome, tone,
contentMaturity, audiencePosture, expectedViewingContext, emotionalRegister,
humorLevel, formalityCeiling, formatPromise, antiFormat,
slideMode, complexity, likely slide count, density, image/evidence role,
data needs, brand/source needs, source deck/template if supplied
```

Audience and content maturity are binding. A playful, classroom, party, fandom, entertainment, or joke prompt should not become a sober consulting deck unless the user explicitly wants that contrast.

## Narrative First

Build the deck from a shared story before designing slides:

```text
thesis: main claim
arc: beginning -> tension -> evidence -> landing
audience shift: what changes in the viewer's mind
progression system: how the deck shows movement
slideList: one job per slide
```

Default to a live-presentation reading load unless the user asks for a research appendix or dense leave-behind. If a slide needs paragraphs or tiny text, split it or convert the material into a chart, table, diagram, image-led explanation, speaker notes, or a sharper claim.

Every non-appendix slide needs:

```text
1 dominant element: title, number, chart, image, diagram, or table
1 proof layer: minimum evidence to make the point credible
0-1 context layer: short source, caveat, or quiet label
```

## Visual Direction

Choose a deliberate mode: creative/editorial, work/structured, or template-following.

- Creative decks may use asymmetry, oversized type, strong crops, expressive color fields, masks, subject imagery, and poster-like rhythm.
- Work decks should be calm, aligned, spacious, and mechanically predictable.
- Template-following decks inherit the source deck's visual system unless the user asks for redesign.

Avoid repeated fallback scaffolds: dashboard opener, KPI strip, title plus three cards, hero/media rail plus explanatory cards, and generic dark gradients. Visible big boxes are opt-in, not the default grammar.

## Title Page Gate

The first slide is a cover, not a normal content slide. Define:

```text
titlePageConcept:
  promptRead
  audiencePromise
  coverThesis
  chosenArchetype
  rejectedCliches
  dominantElement
  typographyMove
  paletteMove
  imageOrEvidenceMove
  negativeSpacePlan
  whyThisCouldOnlyBeThisDeck
```

The cover fails if it could work for another subject after swapping the nouns.

## Compose-First Layout

Build macro regions first, then fill them. Major readable regions should be siblings inside one composed root `column`, `row`, `grid`, or `layers` scaffold so wrapping text changes layout instead of colliding with it.

Rules:

- Use `layers` for backgrounds, slanted planes, masks, overlays, and measured art direction. Do not use it as the primary flow for readable titles, subtitles, labels, metrics, or body text.
- Do not scatter title, subtitle, body, media, and footer as unrelated fixed-position text boxes.
- Prefer intrinsic or `hug` height for variable text.
- Use fixed text frames only after exported layout evidence shows slack.
- Name important text, chart, table, and footer nodes for inspection.
- Keep all live content inside slide bounds and safe areas.

Layout smells:

- unrelated absolute frames for title and body
- fixed title height without exported proof
- matching a PNG while ignoring PowerPoint wrapping
- using `layers` as the main layout system
- one-line labels that accidentally wrap

## Typography

Typography is a storytelling surface. Do not default to neutral system fonts unless the brand/template or subject asks for that voice.

Legibility floor for normal live slides:

- body/callout text is usually 24 pt or larger
- important labels are usually 18 pt or larger
- chart/table labels are usually 14 pt or larger
- source/footer text may be 10-12 pt only when it is quiet context, not required for the live read

If text is too small, shorten copy, split the slide, enlarge the visual system, or move detail to notes/appendix. Do not solve density by shrinking everything.

## Assets

Use reference material as evidence, not slide cargo. Extract ideas, stats, quotes, and useful visuals; do not embed whole PDFs/docs/pages/screenshots unless the slide is explicitly critiquing or showing that artifact.

Use real raster assets for real subjects:

- searched/official assets for companies, products, people, places, logos, screenshots, venues, events, datasets, and cultural works
- generated raster assets for original concepts, educational illustrations, and composite explanatory scenes
- native shapes for structure, labels, masks, highlights, callouts, alignment, chart marks, and layout chrome

Do not build complex subject imagery with SVG, Canvas, procedural drawing, or exported shape art.

Image prompts should leave calm regions for editable text and charts. Generated images are visual assets, not factual sources, and generated text should not become final slide copy.

## Data, Charts, Tables

Data slides should be beautiful and useful, not default Office output.

Before authoring, define:

```text
dataObjectPlan:
  chartableClaims
  nativeChartNodes
  nativeTableNodes
  customDataDiagrams with rationale
  paletteMapping
  typographyMapping
  annotationStyle
  renderChecks
```

Use editable charts for ordinary bar, column, line, combo, waterfall, pie/doughnut, scatter/bubble, funnel, histogram, treemap, map, and distribution views. Use native or authored editable tables for tabular comparisons, rankings, guidance, risks, and distributions. Shape-built pseudo-charts are an exception and need a reason.

## Template Following

When a source deck is supplied:

- use clone-first adaptation if a source slide is close to the requested slide
- use reference rebuild only when no source slide is a good skeleton
- preserve template chrome, backgrounds, spacing, typography voice, media framing, and component geometry
- rebuild text-heavy regions with composed layouts inside inherited frames
- do not replay exported layout JSON at runtime

## QA

Render or inspect final output at full slide size. A montage/contact sheet is useful only for deck rhythm.

Blocking failures:

- title/subtitle/body overlap
- clipped or off-slide text, charts, tables, captions, logos, footers, or sources
- one-line labels/chips/metrics wrapping unintentionally
- metric labels colliding with numerals
- unreadable text over busy images or low-contrast fields
- visible placeholder text or slide-number placeholders
- fake, unresolved, irrelevant, tiny, or repeated subject imagery
- implementation meta text such as "generated with", "built with", "native chart object", or "this deck"

For title-heavy or text-dense decks, saved-PPTX inspection is authoritative for wrapping, line spacing, vertical alignment, and placeholder behavior. If available, inspect layout metrics:

```text
textLayout.height <= bbox/frame height
max(textLayout.lines[].width) <= bbox/frame width
intentional one-line labels have textLayout.lineCount == 1
no unintended bbox intersections among title, subtitle, body, chips, footers, and source text
```

Patch source and rerun QA until clean, unless the user explicitly accepts a draft.
