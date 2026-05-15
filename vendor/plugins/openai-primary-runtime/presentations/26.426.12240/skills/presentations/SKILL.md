---
name: Presentations
description: Create, edit, render, verify, and export PowerPoint slide decks. Use when Codex needs to build or modify a deck, presentation deck, slide deck, slides, PowerPoint, PPT, PPTX, or .pptx file.
---

# Presentations

Turn a short user prompt into a polished, editable presentation with the bundled `@oai/artifact-tool` presentation runtime.

This skill uses the Codex runtime bundle's installed `@oai/artifact-tool` package plus the local `references/granola-jsx.md` and `references/presentation-design-workflow.md` files. Load only the minimum relevant references for the request class. When authoring/exporting JSX, read the local references for the current JSX node set, imports, image behavior, export helpers, and output contract.

Default workspace: the setup-created writable workspace for the deck. If the bundled `@oai/artifact-tool` runtime is missing or too old, install or refresh the Codex runtime bundle before authoring.

## Operating Model

Simple, consistent slides win when the topic calls for clarity; bold, surprising slides win when the topic calls for energy. Treat this as design direction, not a template system: the skill should shape taste, hierarchy, and restraint without forcing a fixed layout recipe. The goal is lean, high-signal content in a beautiful sequence, not research notes squeezed into slide-shaped pages. Do not confuse consistency with repeated visible containers; a deck can feel coherent through margins, type, rhythm, color, imagery, data treatment, crops, slants, masks, and repeated emphasis behavior without turning every slide into boxed regions.

Before design, classify the deck's content maturity and audience posture. A playful prompt should not be laundered into a formal work deck unless the user explicitly wants deadpan contrast and the deck visibly commits to the bit.

```text
contentMaturity: silly/playful | casual/explainer | serious/work | technical/educational | premium/brand
audiencePosture: friends/fans | students/learners | coworkers/operators | execs/buyers | public/brand
emotionalRegister: fun | warm | curious | urgent | trustworthy | cinematic | premium
humorLevel: none | light | overt | absurd/deadpan
formalityCeiling: how formal the deck is allowed to feel
formatPromise: one sentence describing what the deck should feel like and what it must avoid
antiFormat: structures, palettes, and tropes that would betray the audience or topic
```

This gate is binding. If a generated slide could pass as a consulting, board, or strategy deck after swapping the nouns, fail the design for `silly/playful`, entertainment, fandom, game, party, classroom icebreaker, or joke prompts. Do not force scorecards, rubrics, dashboards, dark executive palettes, tiny source footers, or sober panel grids onto playful topics unless that exact contrast is the joke.

Guidance is a priority system, not a checklist to mechanically expand. Keep planning artifacts compact; if a note does not change the JSX, palette, asset choice, or QA decision, do not write it. When instructions compete, resolve in this order: user intent and content maturity, text/PPTX safety, role-aware color/energy fit, one-job slide hierarchy, real assets and editable JSX primitives, then polish details. Text/PPTX safety is a hard gate: no palette, typography, overlap, or art-direction choice can override readable, non-colliding exported text. A deck that is technically compliant but emotionally wrong has failed the skill. Do not let caution language flatten creative decks into safe rectangles; use the safety rules to keep bold composition editable, legible, and intentional.

Classify the request before composing:

- `full deck`: multi-slide presentation from a prompt, sources, or brief.
- `single-slide build`: one authored slide or one replacement slide.
- `visual refresh`: improve an existing deck/slide while preserving content intent.
- `API/snippet question`: answer about Granola/presentation JSX usage; do not run the deck pipeline unless asked.
- `UI mockup embedded inside a slide`: create a slide whose dominant visual is a product/UI surface, not a live app.

Pick the minimum references needed:

- `API/snippet question`: Granola JSX docs and the specific local examples needed to answer.
- `single-slide build`: Granola JSX docs plus supplied source/reference material for that slide.
- `full deck`: Granola JSX docs, user/source materials, and only the brand/data/image references needed for claims and assets.
- `visual refresh`: source deck/slide renders, layouts, fonts/assets, and Granola/OpenXML inspection tools; avoid unrelated inspiration.
- `UI mockup embedded inside a slide`: Granola JSX docs plus product/brand references for the UI being represented.

Build the deck from shared context, then build each slide from `deckContext + slideBrief`.

```text
request -> classify -> audience/content maturity gate -> minimum references -> intent -> narrative -> text economy gate -> role-aware palette gate -> design brief -> structure strategy -> coherence/variability gate -> deckContext -> short slide specs -> assets -> macro layouts -> slide builds -> integrated JSX -> export -> rendered QA
```

The main agent owns the story, shared context, final integration, export, and QA. Slide workers, when the user explicitly requests subagents/delegation and runtime policy permits, only build assigned slides from the shared contract.

## Hard Rules

- Output must be editable presentation-native content, not screenshots of web pages.
- Reference material is source input, not slide cargo. Do not upload/embed whole PDFs, docs, decks, pages, screenshots, or wordy excerpts into the output unless the slide is explicitly critiquing or showing that artifact. Extract only the ideas, stats, quotes, and visuals that advance the story, then cite/reference the factual source succinctly. Do not cite tool usage, image generation, research process, or asset provenance as slide/footer copy.
- Use reference material as evidence, not slide cargo. Only place reference-derived assets onto slides when they are true visual assets such as logos, product screenshots, photos, charts/figures, diagrams, artwork, or template/background elements.
- Use Granola JSX and native PPTX-safe primitives. Do not use SVGs as visuals, and do not hide SVG-like or Canvas/JSX-drawn illustrations inside exported PNGs.
- Use real, resolved raster assets for subject imagery; native shapes are for structure, data, labels, callouts, masks, slanted stage planes, typographic anchors, and compositional color fields, not fake illustrations or arbitrary decoration. A PNG made from procedural shapes, OffscreenCanvas drawing, SVG paths, or JSX geometry is still shape art, not a valid subject-image asset.
- Use JSX to make each slide feel deliberately authored: either spare, elegant, and whitespace-rich, or visually ambitious and memorable. Avoid generic middle-ground layouts.
- Accidental text wrapping, clipped text, text-on-text overlap, and label/metric collisions are blocking defects. If a one-line label wraps, a title collides with a subtitle/body object, or a large number crosses readable copy, rebuild the layout or rewrite the text before export.
- Do not launch PowerPoint, Keynote, LibreOffice, Preview, Finder, `open`, `osascript`, or desktop automation. Use headless Granola/OpenXML/package tooling only.
- Keep slides clean. One slide, one job, one hierarchy, one dominant visual/data object.
- Most presentations are not research outputs. Unless the user explicitly asks for a research memo, appendix, diligence pack, or dense leave-behind, optimize for what a viewer can grasp live in a few seconds: a sharp claim, a beautiful evidence object, and minimal supporting context.
- Rich data must still look simple. Complexity belongs in the underlying analysis, not in equal-weight slide furniture. Prefer one foreground signal plus one quiet proof layer over many small competing components.
- Data-rich decks must use editable presentation-native data objects. For investor, earnings, market, benchmark, financial, operating, scientific, or research decks, use Granola `<chart>` nodes for chartable relationships and either well-styled native `<table>` nodes or authored JSX table systems for tabular comparisons, guidance, risks, rankings, and distributions. A native table is not automatically acceptable: if it renders like a stock Office grid, rebuild it as a deck-designed editable JSX table made from rows, columns, rules, shapes, and named paragraphs. KPI cards, hand-built rectangle bars, and text callouts may support the read, but they must not replace charts/tables when the relationship is chartable.
- Shape-built pseudo-charts are an exception, not a fallback. Use boxes/shapes/rules to make custom data diagrams only when the visual relationship is not supported by native chart/table nodes or when the slide needs a bespoke annotated construct; record that reason in the slide brief. Do not recreate ordinary bar, column, line, combo, waterfall, pie/doughnut, scatter/bubble, funnel, histogram, or treemap views out of boxes. Tables are the exception: authored JSX tables are allowed, and often preferred, when native `<table>` styling cannot meet the deck's typography, spacing, grouping, or conditional-encoding standard.
- Visible big boxes are opt-in, not a default slide language. A visible big box means any filled, stroked, shadowed, tinted, or panel-like rectangle/card/tile/block that occupies a major region of the slide or is used as a home for prose, bullets, or a mini-section. A normal slide should not be a big rectangle containing text, and a normal deck should not be a sequence of big rectangles containing text.
- Text is not allowed inside big visible boxes unless the user explicitly asks for a worksheet, form, agenda board, menu, schedule, quote card, product/UI mockup, reference card, dashboard, or another artifact whose real-world form is boxed. Even then, the box is the artifact, not the generic slide template; keep prose short and make the artifact visually intentional.
- Big visible containers, when allowed, must primarily hold a real object: chart, table, image, UI surface, map, calendar, menu, artifact excerpt, or structured comparison. They must not be the main way to make paragraphs feel designed. If a box mostly contains prose, rewrite the prose as open typography, direct labels, a table, a diagram, speaker notes, or a separate slide.
- Giant mostly empty cards are not a premium substitute for whitespace. Do not make large blank tiles that hold only a number, tiny label, and bottom caption; use open metric typography, a real chart/table, a compact comparison, or one strong visual field instead. If the card is mostly empty, the slide probably needs a different composition.
- Do not make boxes, blocks, square tiles, cards, or boxed paragraphs the core visual template across a deck. Boxes are useful only when they organize a real comparison, dashboard, worksheet, artifact surface, or reference object the audience expects to see contained.
- Treat cards as rare punctuation, not grammar. For a normal 6-10 slide deck, one compact KPI-card cluster or one genuinely modular operating snapshot can be appropriate; repeated card grids, right-rail fact stacks, large boxed executive-read panels, and "title plus three boxes" slides need explicit justification in the structure strategy and usually fail for social, travel, lifestyle, hospitality, wedding, bachelorette, birthday, classroom, fandom, and personal-event decks. Prefer open composition, direct labels, real charts/tables, diagrams, expressive images, and whitespace before adding another container.
- For simple topics and short prompts, repeated structure means a consistent editorial rhythm, not repeated boxes. Use stable margins, type, image language, and motifs; vary scale, crop, placement, and emphasis so the deck feels designed instead of gridded. Do not add a progress widget by default.
- Do not make lazy repeated "title + 3 cards" decks unless that scaffold genuinely supports the narrative or the user asks for a dashboard.
- Reject familiar fallback compositions when they appear by habit, especially a hero/media rail on one side with explanatory cards or text on the other. Replace them with a stronger stable scaffold, not random slide-by-slide novelty.
- Title pages must be designed as the deck's first impression, not as slide 1 of the content system. Build a distinct cover concept from the prompt: one dominant idea, one memorable visual or typographic move, one clear audience promise. A good cover should look inevitable for this deck and wrong for another deck after only swapping the nouns.
- Make each title page fit the row's content and audience. The opener can be subtle or bold, quiet or expressive, but it should not force a generic house style, busy navigation, or arbitrary decorative system across unrelated rows.
- Typography is a primary storytelling surface, not a default style choice. Do not default to Avenir, Inter, SF, Helvetica, or Arial unless the deck intentionally needs that neutral product/system voice, the template/brand requires it, or the renderer has no better available option.
- Full-slide image backgrounds are for exceptional creative/design cases, not normal work decks.
- Render final PNG previews and inspect them before final response.
- Do not treat the montage as visual QA or PPTX parity. The montage is a downscaled contact sheet assembled from Granola-exported slide PNGs; it does not reopen the saved `.pptx`, does not exercise PowerPoint/Keynote text layout, and can hide collisions that are visible on an individual slide. Use it only for deck rhythm.
- If current facts, public companies, markets, people, prices, laws, or recent events matter, verify them before using them.
- Final response must include export path, preview paths, test command, PNG inspection status, and any unresolved issues.

### Title Page Design Gate

Treat the title page as a premium editorial cover. Before writing JSX for slide 1, define and satisfy this cover brief:

```yaml
titlePageConcept:
  promptRead: "What the prompt is really asking this deck to signal"
  audiencePromise: "Why this audience should keep reading"
  coverThesis: "The single idea the cover must land"
  chosenArchetype: "editorial masthead | monumental statement | full-bleed image | artifact cover | typographic poster | one-number market cover | map/field cover | quote-as-title | premium report cover"
  rejectedCliches: ["generic dashboard opener", "hero plus card rail", "metric-card grid"]
  dominantElement: "The one visual/type/data element that owns the page"
  supportingElement: "Optional secondary element that stays clearly subordinate"
  typographyMove: "Scale, measure, alignment, rhythm, and contrast"
  paletteMove: "How the palette expresses the subject and audience"
  imageOrEvidenceMove: "Specific asset, chart fragment, number, texture, or object if used"
  negativeSpacePlan: "Where the slide breathes and why"
  brandExpression: "How the institution, product, or personality shows up without lazy logo placement"
  whyThisCouldOnlyBeThisDeck: "A testable sentence proving prompt-specificity"
  acceptanceChecks:
    - "Thumbnail reads as a deliberate cover, not a normal content slide"
    - "One dominant idea, not multiple equal-weight claims"
    - "No generic card grid, KPI strip, or dashboard scaffold"
    - "The design would fail if the subject nouns were swapped"
```

Choose exactly one primary cover archetype. Do not blend multiple cover ideas into a busy collage. If the cover is type-led, make typography, alignment, and negative space carry the design. If the cover is imagery-led, the image or evidence object must be exceptional, relevant, and large enough to be the page's reason for existing. If the cover is data-led, use one unforgettable number or one distilled artifact, not a cluster of metrics.

Banned title-page defaults unless the user explicitly requests them:

- Dashboard opener, 2x2 card grid, KPI strip, or metric-card constellation.
- Split hero/media rail with explanatory boxes on the other side.
- Huge title plus long subtitle plus decorative panels.
- Generic dark gradient with floating stats.
- Boxed prose, stacked pill labels, or multiple equal-weight takeaways.
- Brand reduced to tiny corner text while the rest of the page is generic.
- A cover that could work for any client after replacing the company or sector name.

## 1. Orient

Infer what the user did not specify unless blocked.

Capture:

```text
requestClass, topic, audience, decisionToUnlock, outcome, tone,
contentMaturity, audiencePosture, expectedViewingContext, emotionalRegister, humorLevel, formalityCeiling, formatPromise, antiFormat,
slideMode, complexity(simple/moderate/complex), likely slide count, density, image/evidence role,
data needs, brand/source needs, source deck/template if supplied
```

If a brand, product, venue, public company, cultural work, person, or current topic is involved, prefer official/public sources for claims, colors, logos, screenshots, and imagery. Do not invent brand assets, logos, UI, product renders, screenshots, or factual claims.

## 2. Narrative First

Do this before design.

Light content still needs narrative. For silly, playful, casual, or short prompts, build a lightweight arc rather than adding artificial density: setup, tension/joke, reveal, winner/landing, or "why this matters to this audience." A fun deck can be sparse, punchy, and image-led as long as each slide advances the sequence. Do not make playful decks feel important by adding formal frameworks; make them feel intentional by giving the audience a clear ride.

Create:

```text
thesis: main claim
arc: beginning -> tension -> evidence -> landing
audience shift: what should change in the viewer's mind
progression system: how the deck shows movement from slide to slide
slideList: one job per slide
```

Keep a text-economy note while planning; this is guidance, not a separate deck-building phase:

```text
contentIntent: live presentation | decision memo | research appendix | sales narrative | educational walkthrough
readingLoad: light | medium | dense
audienceFit: what this audience wants to feel, laugh at, trust, learn, or decide
toneContract: how serious, playful, warm, premium, or technical the deck is allowed to be
primaryMessages: the few claims the audience must remember
supportingEvidence: data, examples, or sources that prove those claims
textEconomy: where text should become a chart, diagram, short label, speaker-note idea, or appendix/reference detail
blockRisk: where boxes, cards, square tiles, boxed panels, or long text-in-box layouts would become a lazy template
openTextPlan: how prose becomes open type, direct labels, chart/table annotations, diagrams, speaker notes, or separate slides instead of boxed text
containerExceptionBudget: which visible big boxes are allowed, if any, and the reason each one is necessary
breathingRhythm: where the deck should use sparse slides to create emphasis and relief
```

Default to `live presentation` reading load unless the user asks otherwise. If the material is rich, preserve the intelligence with stronger visual forms, not more boxes. A slide that requires paragraph reading, tiny labels, or several unrelated comparisons is usually trying to do more than one job.

Choose slide count from narrative load, not a fixed tiny target. It is fine to spread content across more slides when that avoids crowding; each slide should have one clear job, one dominant read, and enough whitespace. Avoid sprawl by stopping when the story is complete.

Assign each slide a density role:

- `title / section`: minimal, iconic, memorable.
- `visual explanation`: diagram/process/labels, not prose.
- `evidence`: one strong chart/table/data object plus takeaway.
- `comparison`: rich comparative chart, matrix, or ranked table.
- `reference / appendix`: denser, but still readable.

If a slide needs paragraphs or tiny text, split it or convert it into a chart, table, diagram, image-led explanation, speaker notes, or sharper claim. Do not solve density by putting the text in a big rectangle; that pattern makes the container louder than the idea and is a blocking design defect for non-appendix slides.

For non-appendix slides, require a visible hierarchy contract:

```text
1 dominant element: title, number, chart, image, diagram, or table that carries the point
1 proof layer: the minimum evidence needed to make the point credible
0-1 context layer: short source, caveat, or label, visually quiet
```

This is not a layout template. It is a reading contract. The exact composition can vary, but the viewer should never have to decide which of five similarly loud objects matters first.

## 3. Intent, Mode, Design Brief

Choose mode after narrative:

- `creative / editorial`: cultural, playful, cinematic, educational, brand-world, inspirational, art, entertainment, or memory-first.
- `work / structured`: executive, consulting, strategy, sales, research, technical, financial, scientific, product, roadmap, board, planning, or trust/reuse-first.
- `template-following`: supplied `.pptx`, template, source/reference deck, existing slide, or request to match/use/follow a deck.

Creative decks may use surprise, asymmetry, varied title zones, unusual scale, expressive crops, diagonal/slanted composition, masked imagery, and poster-like type. Intentional visual overlap is allowed for shapes, images, masks, color planes, decorative display type, and measured art direction; it is not allowed to make readable text collide, wrap unexpectedly, or become ambiguous. The restriction is not "no shapes"; it is "no meaningless shapes." A slanted plane that creates a stage, crop, reading path, scoreboard lane, ticket edge, image mask, or data field is design structure. A floating blob, orb, squiggle, decorative badge, or filler geometry with no reading job is clutter.

For `silly/playful` or entertainment prompts, make the deck audience-native before making it polished. Prefer formats such as a game-show board, talent-show stage, bracket, trading card set, mixtape liner notes, field guide, pop magazine spread, judge's notebook, backstage pass, arcade results screen, or character dossier when they fit the topic. Use brighter or more varied palettes, expressive scale, friendly copy, jokes in labels, and subject images as active cast members, props, or scene anchors. Avoid corporate scorecards, formal rubrics, sober executive navy, tiny citations, and equal-weight analysis panels unless the whole deck is an intentional parody.

Work decks should be calm, aligned, spacious, and mechanically predictable.

Template-following decks inherit the source deck's visual system unless the user asks for redesign.

For any multi-slide deliverable, write a compact design brief before slide specs:

```text
designBrief:
  visualMode:
  contentMaturity:
  audiencePosture:
  formatPromise:
  formalityCeiling:
  paletteFamily:
  paletteSource:
  paletteTokens:
  paletteRoleMap:
  colorEnergyTarget:
  imagePalettePlan:
  typeCast:
  typeNarrative:
  surfaceStrategy:
  imagePosture:
  toneAndHumorRules:
  motifBehavior:
  densityDirection:
  textEconomyRules:
  openTextStrategy:
  boxBlockAndCardPolicy:
  containerExceptionBudget:
  hierarchyContract:
  breathingRhythm:
  titlePageDesignGate:
  structureStrategy:
  antiReference:
```

Define structure strategy before slide specs:

```text
structureStrategy:
  primaryScaffold:
  repeatedElements:
  progressionMechanism:
  allowedVariations:
  creativeGeometry:
  cropAndMaskRules:
  openCompositionRules:
  containerExceptionBudget:
  sectionBreakRules:
  titlePageRules:
    chosenArchetype:
    bannedDefaults:
    promptSpecificityTest:
    dominantElement:
```

`structureStrategy` describes how the deck stays coherent; it must not become a forced template. Prefer directional constraints such as "wide title rail, one dominant evidence field, quiet source footer" over brittle prescriptions such as "every slide uses three cards." Repetition is good when it creates calm, but each slide still needs a chosen emphasis.

For creative decks, choose 2-3 composition levers from the Granola JSX surface and actually use them: layered color planes, `image` crop/fit/geometry/rotation, `paragraph` transform, masks, full-bleed or oversized imagery, native rules, styled chart/table objects, and composed grids/rows/columns. Do not invent browser/CSS effects Granola cannot export; do use the editable primitives it has to make the slide feel authored.

For simple topics, use one primary editorial rhythm for most content slides, plus at most one opener/closer or section-break variation. The deck should feel like a beautiful sequence: margins, type, and motif behavior stay predictable while the active emphasis, image crop, scale, data object, or spatial composition changes.

Box/block/card restraint is part of the structure strategy. Start fresh decks with a zero-large-container default. Add a visible big box only when the user asked for that artifact form or when the content is truly comparative, modular, operational, or reference-like and a table/chart/UI/artifact surface is the right object. Do not use a grid of boxes or squares as the key template for every slide, and do not park paragraphs inside boxes or blocks. Prefer open composition, large type-led claims, single strong evidence objects, native charts/tables, diagrams, expressive imagery, and whitespace over repeated containers.

### Container Abstinence Gate

Run this gate before slide specs and again during rendered QA. It is binding for all fresh decks unless the user explicitly asks for boxed slides.

```text
containerAbstinenceGate:
  default: no visible big boxes, no boxed paragraphs, no deck built from repeated panels
  bigBoxDefinition: any visible filled/stroked/shadowed/tinted rectangle, card, tile, panel, block, or square that occupies a major slide region or houses prose/bullets
  allowedExceptions: explicit user request; native chart/table surface; product/UI mockup; real artifact such as schedule/menu/worksheet/form; map/calendar; quote card; reference appendix; genuinely modular dashboard
  forbiddenUses: making text feel designed; filling empty space; creating a repeated "title + boxes" template; hiding weak hierarchy; replacing a chart/table/diagram/image
  emptyCardRule: large mostly empty cards with a number/title at top and tiny caption at bottom fail; use open metric type, a real evidence object, or a compact comparison
  textRule: prose and bullets may not live in big visible boxes; use open type, labels, tables, diagrams, speaker notes, or split slides
  slideRule: a slide may not be dominated by visible container panels unless the artifact/form itself is the point
  replacementPlan: name the open composition, chart/table, diagram, image-led, or split-slide alternative for every rejected container
```

Small labels, hairline rules, chart plot areas, table cells, image masks, and invisible JSX layout `<box>` nodes are not automatically violations. The violation is visible container-as-template, especially large prose boxes.

Large color planes, slanted stage shapes, image masks, diagonal crops, and scoreboard/ticket surfaces are not container violations when they carry the composition or artifact form and are not just boxes for prose. Keep prose open, short, and placed by hierarchy; let the plane or crop shape the slide.

Specific anti-pattern to reject: a headline above three or four oversized blank cards, each with a large price/number at the top and a tiny explanatory caption stranded near the bottom. That is not hierarchy or spaciousness; it is boxed filler. Redesign as open numbers on a shared baseline, a stepped comparison, a table, a ranked chart, or one dominant takeaway with small supporting labels.

Use a visible progression system only when it helps orientation. It is optional, not a default requirement; omit it for short, cinematic, editorial, portfolio, or creative decks when the sequence already reads naturally. For complex step-by-step narratives, prefer a keynote-style build: keep the same scaffold across adjacent slides and change the highlight, crop, annotation, opacity, data emphasis, or short active text. Reusing the same slide state with one meaningful change is often more premium than adding navigation chrome.

When used, progression must move forward monotonically and never imply going backward to an earlier step/section. Keep it quiet unless the deck is long or instructional. Invent the device from the deck's own subject, metaphor, data shape, or narrative arc; do not choose from a stock menu or paste in generic segmented bars. Do not use detached rows of little rectangles, beads, pills, chips, dots, or status blocks in a slide corner as decorative progress. Do not repeat generic top pill rows, and do not turn progression into a full-height website-like sidebar/nav rail unless the user explicitly asks for that structure.

Avoid sidebars as a narrative-flow default. A side rail is allowed only when the deck is explicitly an index, agenda, dashboard, reference manual, or product navigation mockup. For most narratives, show sequence through repeated composition, changing emphasis, spatial movement, chapter title pages, direct section labels, or builds that revisit the same visual with new callouts.

Do not default to rounded pill/chip navigation or badge rows. For orientation, decide whether a cue is needed and design it from the deck's own visual language. Use pills only when they encode a real state/filter/tag and the text can be one line, vertically centered, fixed-height, and padded with slack.

Run a coherence/variability gate before slide specs. Compare against recent or adjacent deck patterns available in the workspace or conversation. If the new deck would look too familiar, ban at least two stale traits, but do not ban structural consistency for simple decks.

```text
variabilityGate:
  comparedAgainst:
  familiarRisks:
  bannedTraits:
  replacementArchetypes:
  consistencyRules:
```

The `antiReference` and `bannedTraits` are binding constraints. They should prevent overused visual cliches, default dashboards, and overly safe hero-plus-text structures unless the user explicitly asks for them. They must not force every slide into a different structure.

## 4. Deck Context

Create this compact shared context before any slide code:

```text
deckContext:
  topic:
  audience:
  audiencePosture:
  outcome:
  thesis:
  arc:
  mode:
  contentMaturity:
  voice:
  emotionalRegister:
  humorLevel:
  formalityCeiling:
  formatPromise:
  antiFormat:
  constraints:
  theme:
    palette:
      source:
      tokens:
      contrastPairs:
      dataSeries:
      imageSampling:
    typography:
      typeCast:
      typeNarrative:
      emphasisRules:
      fontFallbacks:
    imageLanguage:
    chartTableStyle:
    layoutRules:
  contentPlan:
    contentIntent:
    readingLoad:
    primaryMessages:
    supportingEvidence:
    textEconomy:
    openTextStrategy:
    boxBlockAndCardPolicy:
    containerAbstinenceGate:
    hierarchyContract:
    breathingRhythm:
  designBrief:
  structureStrategy:
  variabilityGate:
  continuity:
    titlePageConcept:
    motifs:
    logoLockup:
    progressionSystem:
    titleRules:
    footerSourceRules:
    spacingRules:
  factsAndSources:
  assetInventory:
```

Every slide must obey this. Individual slides may vary composition, but not invent a new deck.

## 5. Theme From Narrative

Do not use templates for fresh decks. Keep the theme coherent and intentional; "clean" must not mean timid. For creative decks, the theme needs a memorable surface: a role-based color system, crop language, type behavior, artifact metaphor, data/diagram treatment, or layout move that would still be recognizable in a thumbnail.

- Creative: make it magical, fun, cinematic, editorial, or strange when the story calls for it.
- Playful/entertainment: make it friendly, vivid, and immediately legible to fans or casual viewers. Let the subject's world shape the format, palette, titles, motifs, and image scale. The deck should feel like it belongs at the party, classroom, watch night, fan debate, or creative review where it will be shown.
- Professional: make it excellent, calm, useful, restrained, and easy to trust.
- Technical/scientific: use precise diagrams, readable annotations, and field-guide clarity.
- Brand/product: use verified public/official brand context and assets faithfully.

Define palette tokens, typography, chart/table treatment, image language, and layout rules in `deckContext`. These choices must follow the content maturity gate. Do not default to dark navy, small caps, formal data panels, serious rubric language, or corporate scorecard structures for playful topics. A chart, table, or ranking can be fun, but its wrapper and copy should belong to the audience and premise.

Before accepting any planned image, answer: "Why does this image belong on this slide, and what work does it do for the audience?" If the answer is only decoration, recognition, or filler, redesign the slide or choose a better asset.

### Color Selection Gate

Pick colors after the narrative, content maturity, audience, and key image assets are known. Do not choose a palette because it looks generically premium. Treat palette work like a Huemint-style layout problem: generate colors for roles in the final design, not a flat row of swatches.

Palette sources, in order:

- official brand/product/source colors when brand fidelity matters
- dominant, accent, and character colors sampled from the key images or subject world
- colors implied by the format metaphor, such as stage lights, trading cards, field notes, arcade UI, textbook plates, zines, scoreboards, ticket stubs, tabloid spreads, or executive documents
- colors implied by the emotional register when no brand, subject-world, or image palette is available
- semantic colors needed for data, status, risk, or contrast

For every fresh deck, write a compact role-aware palette memo before JSX:

```text
paletteMemo:
  source: official | image-sampled | subject-world | format-metaphor | semantic-data | hybrid
  locks: hex colors that must stay, with why each is locked
  roles:
    canvas:
    primaryText:
    secondaryText:
    surfaceOrObject:
    primaryAccent:
    secondaryAccent:
    highlight:
    dataOrStatus:
  contrastGraph:
    primaryText/canvas: high
    secondaryText/canvas: medium-high
    surfaceOrObject/canvas: low-medium or high, depending on whether it should recede or pop
    primaryAccent/canvas: high
    primaryAccent/secondaryAccent: medium-high
    highlight/surfaceOrObject: high
  candidates:
    safe:
    vividComplement:
    wildcard:
  chosenCandidate:
  roleUseBySlide:
  imageRelationship:
  avoid:
```

Use the contrast graph as a design contract. A useful shorthand is high = 75-95, medium = 45-70, low = 15-40 on a 0-100 perceived-contrast scale. The values do not need exact CIE Delta-E math, but the intent must be clear: readable text, intentional surface separation, and accents that actually have voltage.

For creative, playful, fandom, entertainment, food, travel, party, classroom, cultural, and unbranded decks, generate at least three candidate role palettes before JSX:

- `safe`: faithful source/brand/image colors with reliable contrast.
- `vividComplement`: one locked anchor plus a complementary, split-complementary, triadic, or warm/cool counter-color. Adjust saturation and lightness for the assigned role; do not trust hue math by itself.
- `wildcard`: one surprising high-chroma or unusual role assignment that still respects readability and the subject world.

Prefer at least one near-white or near-black anchor for readability and at least one saturated edge-of-gamut accent for energy when the tone allows it. Designers often make color feel alive by combining role contrast, near-neutral anchors, and saturated edge colors; random rainbows and all-muted palettes both fail.

For non-branded or not-obviously-on-topic decks, the "how" matters more than brand fidelity:

- lock the intended emotional anchor first, such as `after-hours neon`, `sunlit classroom`, `paper zine`, `stadium lights`, `arcade cabinet`, `museum wall`, or `field notebook`
- assign colors to layout roles before judging beauty: canvas, type, surface, primary accent, counter-accent, highlight, and data/status
- make the counter-accent work by lightness and chroma, not just hue; a complement with the wrong value can look muddy or chaotic
- use one dominant chroma, one counter-accent, one highlight, and neutral anchors; do not let five saturated colors compete at equal strength
- test the palette on one real slide sketch: title, image/crop, evidence object, footer/source, and one accent surface

Do not overuse gradients. Start with solid role colors, split fields, crops, contrast, and typography. Use a gradient only when it has a job: light falloff, depth, atmosphere, state transition, image integration, or a hero/title moment. A deck where gradients are the main source of style is usually under-designed; replace some gradients with decisive solid planes, hard cuts, slanted fields, image masks, rules, or native chart/table color.

For image-led decks, sample or visually inspect the actual assets before finalizing colors. Pull a small set of subject colors into full-bleed fields, split stages, image frames, labels, chart highlights, table bands, section cues, or footer rails so the image and deck feel designed together. Do not surround vibrant character/product images with unrelated muted bars, washed-out overlays, or corporate neutrals that make the subject look pasted on.

For playful decks, controlled high-chroma color must be visible in the composition, not hidden in tiny pills. At least half of the normal slides should have a major color field, large expressive type color, subject-color split background, image-integrated accent, or chart/table color system that would still read as intentional in a thumbnail. A mostly dark/gray deck with small yellow chips fails unless the prompt explicitly asks for noir, luxury, or deadpan restraint.

When prompting a model or yourself for palette help, use this shape:

```text
Generate 3 role-based palettes for a [tone] [topic] presentation.
Locked colors: [hex + role/reason].
If no brand/topic colors exist, lock an emotional or format anchor instead.
Roles: canvas, primaryText, secondaryText, surfaceOrObject, primaryAccent, secondaryAccent, highlight, dataOrStatus.
Contrast needs: primaryText/canvas high; surface/canvas [low/medium/high]; accent/canvas high; accent/accent medium-high.
Candidate 1 should be safe/source-faithful. Candidate 2 should use a complementary or split-complementary counter-color. Candidate 3 should be more surprising but still readable.
Avoid relying on gradients; prefer solid planes and clear role contrast. Return hex tokens, role assignments, where each appears on-slide, why the colors fit the audience, and one reason to reject each weaker candidate.
```

For work decks, prefer quieter neutrals and fewer accents, but still choose colors from the subject, brand, or evidence rather than a default navy template. For playful decks, friendly does not mean arbitrary; it means role-aware, bright enough to feel alive, and legible enough to present.

### Educational Textbook Asset Standard

This standard is mandatory when `contentIntent` is `educational walkthrough`, the audience is students/learners, or the topic is biological, medical, molecular, anatomical, chemical, physical, engineering, or other scientific/technical explanation.

For these decks, the default subject imagery must be imagegen or searched raster artwork that looks like a clean modern textbook illustration:

- white or very light neutral background unless the user asks otherwise
- flat, crisp, diagrammatic rendering with semantic colors and clear component separation
- cross-section, cutaway, process, mechanism, or annotated scientific plate composition
- enough empty margin for labels and leader lines
- no cinematic glow, moody hero art, abstract wave fields, procedural texture, stock-photo mood, or generic decorative molecular wallpaper
- no faux-Office geometry pretending to be molecular/anatomical/technical illustration

Use imagegen for original educational plates unless the visual is factual evidence that must be sourced. The prompt should explicitly request `clean modern textbook illustration`, the exact mechanism/structure, white/light background, the palette, the desired aspect ratio, and either `no text, no labels, no watermark` when labels will be added natively, or short specific labels only when generated text is necessary and will be inspected. Prefer native Granola labels/callouts over generated text because native labels remain editable and reliable.

For every educational raster asset, record an `assetStyleReference` and a `textbookStyleCheck` in the asset inventory. If the user supplies a style reference screenshot, use it as the style benchmark without copying its exact content unless requested. Reject and regenerate any educational asset that reads as abstract art, procedural geometry, dark cinematic science art, a low-information icon, or a simple hand-coded shape plate.

## 6. Typography

Use typography aggressively and intentionally. Fonts, weights, italics, color, scale, line breaks, and spacing should help tell the story before boxes, panels, or extra shapes are added.

Typography gate for every fresh deck:

- If a brand/template is supplied, inherit or deliberately adapt its type system. Otherwise inspect local system and user font directories before committing to a voice, and use local font metadata tools such as `mdls <candidate-font-file>` for exact family names when available.
- Choose fonts because they fit the deck's world: cinematic, editorial, technical, playful, luxury, archival, scientific, operational, or brand-native. Never choose Avenir, Inter, SF, Helvetica, or Arial by habit; treat them as neutral fallbacks.
- Define a `typeCast` with clear roles: display/headline, body, eyebrow/label, numerals/data, and optional mono or accent face. Use exact installed family names Granola can render.
- Write a `typeNarrative`: what the typography should make the audience feel, where it should command attention, where it should recede, and which typographic habits are banned for this deck.
- Use formatting as meaning. Bold the claim, mute context, color source/proof accents, italicize or lighten asides, scale key numbers dramatically, and use deliberate line breaks to create pacing.
- Make key stats large and pop. Important numbers should be treated as primary visual objects with scale, contrast, whitespace, and direct context instead of being buried in body copy, small cards, chart labels, or dense tables.
- Prefer type hierarchy over container hierarchy. Before adding a card or box, try stronger title scale, contrast, weight, color, direct labels, or a more expressive display face.
- Treat open typography as the default home for text. Prose should sit directly in the composition with purposeful measure, contrast, and spacing, not inside a large visible backplate. If text needs a container to be readable, first rewrite, enlarge the safe area, change the background, or split the slide.
- Pair expressive display with readable body. One strong display face plus one excellent text face is usually enough; add a numeral/mono/accent face only when it carries a real role.
- Match type to evidence: data-heavy slides need confident numerals and aligned labels; cinematic slides need big memorable title shapes; educational slides need readable annotation labels; playful slides can use more characterful faces.
- Rewrite titles before shrinking them. Work content-slide titles should usually fit on one line; creative slides may hard-break titles for drama.
- Keep deck titles much shorter: prefer 2-6 words for title-slide titles and 3-8 words for normal slide titles. Rewrite title copy instead of shrinking text when it gets sentence-like.
- Build title/subtitle stacks as reserved layout rails with real vertical gaps. Do not absolutely place a subtitle or body object based on a title's hoped-for one-line height; if a title might wrap, rewrite it, hard-break it, or reserve the second line before placing anything below.
- Set a legibility floor before authoring: for normal 16:9 live-presentation slides, body/callout text should usually be 24 pt or larger, important labels 18 pt or larger, chart/table labels 14 pt or larger, and source/footer text 10-12 pt only when it is not needed for the live read. Dense appendix/reference slides may go smaller only if the user asked for leave-behind detail and the full-size PNG remains readable.
- If a slide needs smaller text to fit, rewrite, split the slide, enlarge the text region, or move detail to notes/appendix before shrinking. Tiny text that requires zooming is a design failure, not a necessary compromise.
- Text over photos, gradients, dark fields, or busy image crops must have reliable contrast in the rendered PNG. If readability is even slightly ambiguous, move the text to a calmer crop, change the text color, add a purposeful scrim/solid field behind the text, or simplify the background. Do not rely on a subtle shadow or thin outline as the only contrast fix.
- Validate typography in full-size PNGs and PPTX re-renders. Font substitutions, missed family names, cramped line-height, and weak contrast are design bugs.

## 7. Slide Briefs

Write short slide specs before detailed code. Make one prompt brief per slide; this is the parallelization unit.

```text
slideBrief:
  slideNumber:
  title:
  job:
  audienceFit:
  toneJob:
  densityRole:
  readingLoad:
  primaryTakeaway:
  proofLayer:
  textEconomyPlan:
  scaffold:
  formatFit:
  progressState:
  keyMessage:
  content:
  archetype:
  visualForm:
  dataSpec:
  assetNeeds:
  imageJob:
  imageFitPlan:
  paletteUse:
  layoutIntent:
  continuityHooks:
  openTextStrategy:
  containerException:
  boxBlockAndCardPolicy:
  whyThisFormatWorks:
  antiFormat:
  avoid:
  acceptanceChecks:
```

Each slide must be buildable from `deckContext + slideBrief`.

Keep slides simple unless data richness or the user's request demands complexity. Even then, complexity should be staged: one dominant takeaway, one primary visual object, and only the necessary proof. Adjacent slides should feel progressive, not structurally random. For simple decks, keep the same scaffold and vary the active step, emphasis, visual state, data, or image. For complex decks, use 2-3 composition families maximum and reuse them intentionally.

Every non-appendix slide brief must explain how it keeps text light and hierarchy clear. `containerException` should usually be `none`. If the slide uses a visible big box, card, block, panel, or square tile, it must name the allowed exception category, why the container is necessary, what real object it holds, and why an open-text, chart/table, diagram, image-led, or split-slide treatment would be worse. "Because every slide uses boxes" is a failure. Paragraphs inside boxes or blocks should move to speaker notes, appendix/reference slides, or be rewritten as open type, labels, diagram parts, data objects, or a sharper claim.

Every slide brief must also pass a tone/format check: the structure, color, copy, and imagery should make sense for the content maturity and viewing context. `paletteUse` must name which deck tokens the slide uses, what the accent is doing, and how the colors relate to any image or data on the slide. For playful slides, the acceptance checks must include at least one audience delight or clarity condition, not only spacing and hierarchy.

## 8. Parallel Slide Builds

When the user explicitly requests subagents/delegation and runtime policy permits, assign slides or small slide batches in parallel.

Worker input:

```text
deckContext
assigned slideBriefs
available assets
Granola JSX constraints
target file/module or return format
```

Worker rules:

- They are not alone in the codebase and must not revert others' edits.
- They must preserve shared context and not redesign the deck.
- They return JSX fragments/components, asset notes, and concerns.

The main agent integrates everything into one focused spec and owns final QA.

## 9. Images And Assets

Images must have a narrative job. No generic decoration, fake image use, or baked multi-use-case montages.

Images must also match the audience and tone. For characters, entertainment, pop culture, games, sports, food, travel, venues, or other high-recognition subjects, use imagery as an active performer, cast member, prop, evidence object, or scene anchor. A tiny isolated subject pasted into a formal card is usually not enough. If the image does not make sense to the intended audience without explanation, fail the asset and redesign the slide.

Run an asset-resolution gate before authoring JSX. For each planned raster asset, record: `assetKey`, `slide`, `visual job`, `target frame/aspect`, `placement mode`, `fit mode`, `subject scale`, `safe crop area`, `crop risk`, `mode`, `actual path/url/dataUrl`, `provenance`, `generation method`, `sampledPalette`, `paletteRole`, `assetStyleReference`, `textbookStyleCheck` when educational, `reuse reason`, `why it is not procedural shape art`, and `status`. Do not proceed with placeholder assets. If the asset cannot be resolved, redesign the slide around native data/text or stop and report the missing asset.

File format is not enough. Treat Canvas-generated PNGs, SVG exports, JSX/HTML/CSS screenshots, procedural textures, and hand-coded geometric drawings as native shape art for asset-gate and QA purposes. They may be used only for simple icons, masks, chart marks, data graphics, alignment guides, or deliberately abstract backgrounds where the primitives are the point. They must not be used as complex subject imagery, textbook plates, molecular scenes, product visuals, places, people, or rich hero art.

Generate or source the specific image the slide needs, not a batch of loosely related assets. For use-case/example grids, create one separate image per use case; do not ask imagegen for a single combined montage/collage. Avoid image collages/contact sheets unless the slide is explicitly about the collage as an artifact.

Do not reuse raster images across slides unless continuity, comparison, recurrence, or the same evidence object explicitly requires it; when sourcing images, vary the asset/crop/scale and structure them as intentional side fields, masks, full-bleeds, cutouts, or evidence objects instead of repeating the same centered picture.

For educational or illustrative material, use imagegen/searched raster artwork for textbook-style diagrams, rich visual plates, and detailed explanatory scenes. The illustration itself should look like authored educational art, not Office shapes. Do not hand-draw molecular, anatomical, medical, technical, product, landscape, or scene imagery with Canvas, SVG, JSX shapes, or procedural geometry. Use native shapes only for labels, callouts, highlights, masks, and layout chrome around the image.

Create/source images for the frame they will actually occupy. Match the requested aspect ratio to the final image well, or generate with intentional bleed/safe margins when a cover crop is desired. Use fit/contain for diagrams, labels, logos, UI/product screenshots, evidence, and educational plates; use fill/cover only for imagery that can be cropped without losing the subject. Never rely on default image sizing, and never crop away labels, faces, products, diagrams, or the main subject.

Fit every placed reference visual deliberately: use `contain` for logos, UI, charts, diagrams, and anything where cropping would hide meaning; use `cover` only when the subject can survive the crop. Never stretch, blur, clip important content, or let an asset spill outside its frame.

Image fit and scale are part of the design, not cleanup. Every slide brief using raster imagery must include an `imageFitPlan` that names the frame aspect, fit mode (`contain`, `cover`, `crop with safe margins`, or `native-size/logo`), subject scale, and what must remain visible. Avoid tiny postage-stamp images unless smallness is the point; high-recognition subject imagery should be large enough to read immediately. Avoid stretching, distorted aspect ratios, accidental cover crops, low-resolution blowups, and inconsistent scale across repeated product screenshots, portraits, logos, or evidence objects. If an image feels pasted into an empty box, either enlarge it, crop with intent, integrate it with labels/masks/adjacent type, or choose a better visual.

Minimum raster coverage for normal decks:

- 1-5 slides: at least one resolved searched/generated raster asset.
- 6+ slides: at least three resolved searched/generated raster assets across at least two slides.

Exempt only if the user asks for no images or image access is blocked and acknowledged. Native shapes, charts, tables, procedural textures, and SVG-like drawings do not count.

Use `search` for real things: companies, products, people, places, logos, screenshots, venues, events, artifacts, datasets, cultural works. For brand/business decks, prefer searched official or public assets such as product screenshots, app imagery, leadership portraits, stores/venues, campaign visuals, or logos. Use imagegen for original concepts, educational illustrations, composite explanatory scenes, and subject-specific visuals that do not need to be factual evidence.

For logos, prefer official transparent PNGs. If unavailable, use the cleanest reliable logo asset found. For branded decks, define `continuity.logoLockup` with one normal-slide position, size, clearspace, and variant; use it consistently on every normal slide. Openers, closers, and section breaks may intentionally scale or move the logo, but content slides should not drift.

Use `imagegen` properly: prompt for the exact subject, educational point, style, aspect ratio, and empty space needed for labels. For Presentations deck assets, prefer the built-in Codex `image_gen` tool. When an explicit Image API, CLI, or model parameter is available, request `gpt-image-2` and do not silently fall back to older GPT Image models; never rely on a CLI default. Do not surface the image tool, model, generation method, or asset provenance in slide text, source lines, notes, or the final response unless the user explicitly asks for implementation details. If an internal alias such as `videotape-alpha` or `imagegen2` is desired, first verify that the current tool path resolves that alias to `gpt-image-2`; if unavailable, stop and report the exact error and affected asset keys before fallback.

Do not make generic brand-motif raster plates, fake product visuals, or logo-inspired abstract art as a substitute for real subject matter. For a Spotify deck, for example, use official logos/screenshots/product surfaces or a clearly subject-specific generated/listening scene; do not reuse an abstract green orbit/listening glyph across the deck.

Do not generate fake evidence for real entities.

Work decks should use contained images: cropped evidence, product context, portraits, or visual panels. Avoid full-slide photo backgrounds except exceptional brand/design openers.

Native shapes need a job: structure, annotation, emphasis, data encoding, masking, alignment, labels, arrows, highlights, slanted stage planes, color fields, crop frames, artifact surfaces, or layout chrome. Do not use decorative-only circles, blobs, arcs, badges, oversized filler geometry, Office-shape faux illustrations, procedural textures, OffscreenCanvas drawings, or JSX-drawn motifs as substitutes for subject imagery. Big geometry is welcome when it creates hierarchy, staging, rhythm, masking, or an artifact surface; it fails only when it is arbitrary decoration. Do not write `create*Plate`, `create*Hero`, or similar procedural image factories for complex visuals; use imagegen/search instead, or make the slide a native data/diagram slide.

Save stable assets under the setup-created workspace:

```text
scratch/assets/<deck-slug>/
```

Before final JSX, check:

```text
assetKey, mode, source/path, slides used, target aspect, placement mode, fit mode, subject scale, safe crop area, crop/frame, sampledPalette, paletteRole, assetStyleReference, textbookStyleCheck, status
```

## 10. Data, Charts, Tables

Data slides should be beautiful and useful, not default.

Turn reference material into clear stats, rankings, deltas, benchmarks, or comparisons whenever that makes the story sharper. Wordy source content should be rebuilt as designed claims, numbers, charts, tables, or diagrams, not used as screenshot/image assets or pasted prose.

Run a native-data-object gate before JSX:

```text
dataObjectPlan:
  chartableClaims:
  nativeChartNodes: chart types planned with slide numbers
  nativeTableNodes: table uses planned with slide numbers
  customDataDiagrams: shape-built data visuals, each with why a native chart/table is not a better fit
  chartSufficiencyGate: where low-density charts are rejected or upgraded
  cardBudget: where KPI cards are allowed, why they are not replacing a chart/table, and how many repeated card clusters exist
  dataDesignSystem:
    paletteMapping: series, semantic states, highlights, muted context, fills, rules, axes
    typographyMapping: chart labels, axis labels, table headers, body cells, numerals, footnotes
    structureRationale: why each chart/table form fits the slide's one insight
    annotationStyle: direct labels, callouts, highlights, legends, sources
    defaultBans: stock Office/Excel colors, generic chart fills, black table headers, heavy grids, cramped cells
    renderChecks: label overlap, legend duplication, tick readability, table cell wrapping, contrast
```

For investor, earnings, market, financial, operating, scientific, or benchmark decks, at least the majority of evidence slides should contain a real `<chart>`, a well-styled native `<table>`, or an authored JSX table system unless the slide is intentionally a title, section, visual explanation, or executive summary. A deck with chartable revenue, margin, cash-flow, backlog, guidance, customer, or risk data and zero data objects fails QA.

Every data object must feel native to the deck's theme. Before authoring charts or tables, define how the deck palette, fonts, spacing, and component language apply to data: series colors, highlight colors, axis/rule colors, table fills, table chips, numeric face, label face, header treatment, annotation style, and source treatment. Do not accept generic chart/table defaults as "good enough" because the data is correct.

Reference handling examples:

- Source deck/table screenshot -> extract the few relevant numbers and rebuild as a native chart, metric pair, slope, bridge, or clean table.
- Wordy report page -> rewrite as one sharp takeaway plus 1-3 sourced proof points.
- Investor/earnings reference -> make a designed margin/growth/revenue comparison, not a pasted financials screenshot.
- Educational source figure -> use or generate one subject-specific textbook-style illustration, then add native labels/callouts.

First identify the comparison: ranking, trend, before/after, benchmark, part-to-whole, contribution, distribution, tradeoff, or scenario comparison.

Prefer one excellent data object over many small charts. Use the full chart/table vocabulary: ranked bars, lollipops, dumbbells, slopegraphs, benchmark bands, waterfall/bridge views, scatter/bubble plots, heatmaps, matrix tables, and rich native comparative diagrams.

### Chart Sufficiency Gate

A chart must earn its space. Do not chart a relationship that is too thin to be a useful visual object.

```text
chartSufficiencyGate:
  minimumQuestion: what comparison, trend, distribution, ranking, or decision the chart answers
  dataDensity: number of points, periods, categories, series, benchmarks, and annotations
  rejectedThinCharts: one point, two endpoints connected by a lonely line, one bar, two bars with no benchmark, tiny decorative sparkline
  upgradePath: add history, peer set, benchmark, forecast range, confidence band, decomposition, distribution, or direct annotation
  replacementPath: open metric, delta pair, before/after table, annotated sentence, compact evidence strip, or speaker note
```

Never make a single-series line chart with only two points unless the slide is explicitly about a before/after slope and the visual is styled as an intentional slopegraph or dumbbell with labels, context, and the delta. A line from one point to one point is not a trend; it is a subtraction problem. If the data is only two values, default to a large delta, paired metric, mini table, or annotated before/after construct. If the story needs a real trend, gather or create a richer time series before using a line chart.

Minimum useful chart density, unless the slide brief justifies an exception:

- Line or area chart: 4+ periods, or 3+ periods with a benchmark/target/forecast band and direct annotation.
- Bar/column ranking: 3+ categories, or 2 categories plus a benchmark, gap annotation, or explicit before/after treatment.
- Scatter/bubble: enough points to show a pattern, cluster, or outlier; do not use it for two named dots.
- Pie/doughnut: only for a meaningful part-to-whole read with 3+ slices and a clear dominant point; otherwise use a labeled bar or table.
- Slopegraph/dumbbell: acceptable for two endpoints only when comparing several entities or when one entity's change is the whole slide and the delta/context is visually dominant.

### Chart Design Standard

Charts are designed evidence objects, not exported spreadsheet defaults. A chart should look as if it was drawn for this deck, with the same color system, typography, structure, and emotional register as the surrounding slides.

Minimum chart requirements:

- Use deck/theme colors intentionally: one primary signal color, muted context colors, semantic success/risk/accent colors, and sufficient contrast. Do not use default blue/orange/gray palettes unless those are explicitly the deck's chosen data tokens.
- Set chart fill, plot fill, gridline, axis, label, legend, and data-label styles to match the deck. Defaults are a starting point only.
- Use the deck's type system for labels and numerals. Axis labels, legends, direct labels, and data labels should use the same font roles defined in `deckContext`, with readable size and contrast.
- Choose the chart structure around the one insight: sort bars when ranking matters, use direct labels when legend lookup slows reading, mute historical/context series, and highlight the row/point/period that carries the slide.
- Reject charts with too little evidence density. If the chart is only one point, two endpoints, or a nearly empty plot area, either enrich the evidence object or replace it with open metric typography, a paired comparison, a table, or a sentence.
- Make charts large and composed into the slide, not dropped into a generic bordered card by habit. The chart, title claim, annotations, and source should share an alignment system.
- Avoid clutter: no unnecessary 3D effects, heavy borders, redundant legends, loud gridlines, excessive data labels, or tiny tick text. Gridlines should be quiet enough to support scale without becoming the design.
- Use callouts, benchmark bands, target lines, shaded ranges, or inline labels when they clarify the takeaway. These annotations must follow the same palette and type rules as the rest of the deck.
- Inspect full-size PNGs for label overlap, clipped labels, duplicate legends, cramped axes, illegible ticks, poor contrast, and awkward empty space. Patch the JSX until the chart reads beautifully at presentation size.

Acceptance check: if the chart could be mistaken for an Excel export or a PowerPoint default chart pasted into the slide, it fails. Redesign the chart styling, structure, labels, or surrounding composition.

### Table Design Standard

Tables are designed evidence surfaces, not default widgets. Do not ship a stock-looking native table with black header fills, heavy gridlines, cramped rows, unstyled body text, random banding, or default Office typography in an executive deck.

Before using native `<table>`, decide whether it can satisfy the deck's design system. If the renderer's table style cannot produce the needed hierarchy, alignment, spacing, row grouping, or conditional color, build an authored JSX table component instead. A good JSX table is still editable: each header, cell, badge, rule, and note is a native paragraph/shape inside a shared row/column/grid scaffold.

Use authored JSX tables by default for:

- guidance tables where ranges, periods, and margins need different emphasis
- risk matrices/watchlists with severity, watch metric, or owner/status encoding
- customer proof-point tables with examples plus investor-read labels
- compact comparison tables where one row or column should be clearly highlighted
- any table that would otherwise depend on `TableStyleMedium*` or another stock style as the final design

Minimum table requirements:

- Sort, group, or highlight rows around the slide's single insight; do not present every row as equal if the story has a priority.
- Use a designed header treatment from the deck palette: quiet fill, accent rule, or strong label band; avoid generic black table headers unless the deck system truly uses black.
- Use the deck's type system: header face, body face, numeral face, emphasis weight, and muted/caption style should match `deckContext`, not Office defaults.
- Align numbers by right edge or decimal; align text by reading path; keep column widths intentional and stable.
- Use readable row heights and padding. Executive-slide tables should feel airier than spreadsheet cells; if content needs tiny text, split the slide or move detail to an appendix.
- Use light rules, zebra bands, status chips, accents, or heat encoding only when they clarify comparison. Decoration does not count; every color should have a theme or semantic reason.
- Put the takeaway outside or above the table in a clear claim; the table is proof, not the headline.
- Name important cell paragraphs and inspect them in exported layout JSON when text can wrap.
- Inspect full-size PNGs for cell crowding, weak contrast, wrapped chips, orphan words, heavy gridlines, and off-theme fills. Patch until the table feels lovely, deliberate, and on-theme.

Acceptance check: if the table could be mistaken for a pasted PowerPoint default, it fails. Patch it into a designed JSX table or choose a different visual form.

Map common investor-deck questions to native objects:

- Revenue mix or part-to-whole: native bar, doughnut, stacked/clustered bar, or a labeled table; not a rectangle strip plus cards.
- Subscription/backlog context: native bar, line, combo, or table with direct labels; use callouts only to explain conversion or coverage.
- Margin and cash-flow trend: native line, combo, column, or waterfall depending on whether the story is trend, margin overlay, or bridge.
- Customer metrics: sorted native table, ranked bar, scatter/bubble, or compact matrix; cards only for 1-3 hero metrics.
- Guidance: native table, range bar, dumbbell-style chart, or combo chart; do not bury guidance in a stack of KPI cards.
- Risks: matrix/table, ranked list, heatmap, or scenario comparison; use cards only if the risk taxonomy itself is modular.

For rich data, choose the viewer's question before choosing the chart. The slide should make one comparison obvious: who wins, what changed, where the gap is, which option is investable, what risk matters, or what decision follows. Secondary dimensions can be encoded quietly with labels, ordering, grouping, or muted color, but they should not compete with the main read.

Do not use a grid of boxes, cards, mini charts, square blocks, or pastel tiles just because the source has many facts. If every cell feels equally important, redesign around rank, contrast, grouping, or a single annotated exception. If the detail is necessary but not live-presentable, move it to an appendix/reference slide.

Do not implement ordinary charts manually with `<box>` rectangles, `<shape>` bars, or stacked colored blocks when Granola supports the chart family. Manual marks are acceptable for annotations, highlights, benchmark bands, bespoke process-data diagrams, or chart types that are not available, but the slide brief must say why.

Line charts must be large, readable, and data-rich. Do not make small decorative line charts.

Tables must have styled headers, aligned numbers, meaningful grouping, readable spacing, useful conditional encoding, decisive sorting, theme-native typography/colors, and clear sources. Native `<table>` is acceptable only when the rendered result passes the Table Design Standard; otherwise use an authored JSX table system.

Charts must match the deck palette/type/structure, use direct labels when possible, mute context, highlight the signal, and avoid generic defaults. Use native editable chart objects when possible, but style them until they pass the Chart Design Standard.

Source real-world data. Label synthetic/example data as illustrative.

## 11. Template-Following

If a source deck/template is supplied, this mode is structural, not decorative.

Decide first:

- `clone-first adaptation`: source slides are close to the requested output.
- `reference rebuild`: no source slide is a good skeleton or direct adaptation is unavailable.

Inspect headlessly with available Granola/OpenXML tools:

- `Presentation.load(...)`
- `presentation.inspect(...)`
- `presentation.export({ slide, format: "png" })`
- `presentation.export({ slide, format: "layout" })`
- `exportSlidesForTest(...)`
- package/XML inspection
- repo template-export scripts when available

Inventory skeletons, masters/layouts, title frames, image wells, metric/table/chart regions, component groups, footers, chrome, fonts, logos, and embedded/cropped assets.

Clone-first:

- choose skeleton slides before writing copy
- classify elements as `keep`, `rewrite`, `replace`, `delete`
- extract `templateFrameMap`
- fill inherited frames before inventing layouts

Reference rebuild:

- choose source slides to follow
- derive macro-region constraints from rendered/source artifacts: safe area, title region, content grid, media wells, chart/table regions, footer/source rail, gutters, and alignment rules
- do not translate source artifacts into one fixed text box per paragraph or label; variable text must live inside composed layout regions with intrinsic sizing or verified slack
- rebuild with authored constants and composed layouts, not JSON replay
- match spacing, hierarchy, typography voice, and component geometry

Still obey image, data, and rendered QA rules.

## 12. Author JSX

Before authoring, use this skill's setup script to create a writable deck workspace:

```bash
node scripts/create_presentation_workspace.js --deck-id <deck-slug> --workspace <workspace-dir>
```

Author the JSX/TSX deck module under the setup-created workspace `src/` directory. Put generated/source assets, rendered previews, layout exports, QA reports, and logs under `scratch/`, and export the final user-facing deck to `output/output.pptx`. Do not hard-code absolute local package paths. The setup script links the bundled `@oai/artifact-tool` package from the Codex runtime bundle into the workspace. Before relying on `@jsxImportSource @oai/artifact-tool/presentation-jsx`, prove that `@oai/artifact-tool/presentation-jsx/jsx-runtime` resolves from that workspace; if it does not, stop and say the Codex runtime bundle must be refreshed.

Start generated modules with:

```tsx
/** @jsxRuntime automatic */
/** @jsxImportSource @oai/artifact-tool/presentation-jsx */
```

Use `Presentation.create({ slideSize: { width: 1920, height: 1080 } })`.

Use JSX layout nodes (`row`, `column`, `grid`, `layers`, `box`) and native content nodes (`paragraph`, `run`, `image`, `shape`, `chart`, `table`, `rule`).

Build macro regions first with Granola layout primitives. The slide should read clearly as empty regions before filling copy, data, or media. Push the JSX system: use native charts/tables, layered shapes, precise spacing, reusable components, and rich composition instead of flat placeholders. Apply the deck design system through shared constants and helper components so the result feels authored, not template-generated.

For creative/playful decks, use JSX as a stage, not a document renderer. Use layered native shapes, full-bleed color fields, hard-cut split stages, diagonal/slanted planes, oversized type, image masks, subject cutouts/crops, native rules, chart/table styling, and reusable motif components to make color behave across the slide. Do not let the deck collapse into dark backgrounds plus tiny accent chips, repeated plain cards, or text blocks that could have been made in a generic document editor.

Use Granola's editable surface deliberately:

- `layers` for backgrounds, slanted planes, overlays, decorative/display type overlaps, and measured art direction. Do not use `layers` as the primary flow for readable titles, subtitles, labels, metrics, or body text.
- `grid`, `row`, and `column` for primary layout ownership and safe text flow.
- `image` with `fit`, `crop`, `geometry`, `rotation`, and `flipHorizontal` for expressive subject treatment.
- `paragraph`/`text-box` with `transform`, display faces, hard line breaks, and run styling for poster-like type.
- `shape` and `rule` for composition, masks, lanes, brackets, tables, diagrams, labels, and emphasis.
- `chart` and `table` for editable evidence that is styled into the deck, not left as Office defaults.

The JSX `<box>` primitive is a layout tool, not permission to draw a visible box. Use `<box>` freely for invisible layout grouping, image masks, chart/table shells, and measured composition regions. Do not add fills, strokes, shadows, or tinted panels to large `<box>` regions unless the slide brief has an approved `containerException`.

Before building a data-heavy deck, inspect the Granola chart/table surface and at least one local chart example. Use dedicated `<chart>` children such as `<bar>`, `<line>`, `<combo>`, `<waterfall>`, `<scatter>`, `<bubble>`, `<doughnut>`, `<funnel>`, `<histogram>`, or `<treemap>` where they fit the data. Only fall back to shape-built data visuals after the native option has been considered and rejected for a named reason.

Each slide must have one primary composed root layout for its major regions. Put title/subtitle, body copy, hero media, charts/tables, callouts, footer/source rail, and progression cues inside a shared `row`, `column`, `grid`, or `layers` scaffold so the regions negotiate space together. Use separate absolute `slide.compose(...)` calls for full-bleed backgrounds, decorative marks, measured overlays, or intentionally independent elements only; do not scatter title, subtitle, body, and media as unrelated fixed-position text boxes.

For simple decks, author a reusable scaffold component before individual slides. Keep shared title placement, content zones, footer/source rail, and motif behavior stable. Slide-to-slide change should come from story state and content, not from moving every region around. Use a progress treatment only when it has a real orientation job; do not add decorative status marks because the scaffold has an empty corner.

For work decks, define constants for safe area, title rail, footer/source rail, content grid, gutters, component sizes, and chart/table regions. Treat these as outer contracts for the root layout, not as permission to hard-code tight paragraph heights.

Reserve real space for footer/source material. Do not let source text, page numbers, dates, confidentiality labels, logos, or captions sit outside the primary root layout or under the final content row. If the source is too long for the footer rail at readable size, shorten it to the minimum citation, move detail to speaker notes/appendix, or split the slide. Never solve footer overflow by dropping font size below legibility or letting text run past the slide edge.

For creative decks, define title-zone variation, crop/bleed rules, overlap rules, slant/diagonal rules, motif behavior, and intentional exceptions. Overlap rules must state which objects may overlap and which may not; readable text, one-line labels, metric captions, source rails, and chart/table labels are protected objects unless the overlap is a deliberate text-as-art effect with exported proof that the wording remains legible. Good creative structure can be a repeated diagonal cut, a recurring ticket edge, an image crop language, a scoreboard spine, a tabloid masthead, or a bracket path; it does not need to be a repeated card layout.

### Compose-First Text Regions

Use composed text regions for normal content slides and title slides. The invariant is layout ownership: variable title, subtitle, body, hero media, and evidence regions should be siblings inside one root `column`, `row`, or `grid` so wrapping text changes the surrounding layout instead of colliding with it. Treat numeric values in examples as deck-specific choices, not safety constants.

Normal-slide scaffold:

```tsx
slide.compose(
  <grid
    name="slide-root"
    width={fill}
    height={fill}
    rows={[auto, fr(1), auto]}
    rowGap={layout.regionGap}
    padding={layout.safeArea}
  >
    <column name="title-stack" width={fill} height={hug} gap={layout.titleGap}>
      <paragraph name="slide-title" width={wrap(layout.titleMeasure)} style={styles.title}>
        {title}
      </paragraph>
      <paragraph name="slide-subtitle" width={wrap(layout.subtitleMeasure)} style={styles.subtitle}>
        {subtitle}
      </paragraph>
    </column>
    <grid name="body-grid" width={fill} height={fill} columns={[fr(7), fr(5)]} columnGap={layout.columnGap}>
      {primaryRegion}
      {supportRegion}
    </grid>
    <Footer name="source-rail" />
  </grid>,
);
```

Never build the title page by reusing the normal content slide shell, dashboard scaffold, KPI-card component, or repeated card grid. Create a dedicated `TitleSlide`/`addCover` component from `titlePageConcept`, then render and inspect it before building the rest of the deck. Slide 1 may share the deck theme, but it should not inherit the content-slide layout by default.

Concept-driven title-slide scaffold:

```tsx
const cover = titlePageConcept;

slide.compose(
  <box name="cover-stage" width={fill} height={fill} style={styles.coverStage}>
    {cover.dominantElement}
    <column name="cover-type-lockup" width={wrap(layout.coverTitleMeasure)} height={hug} gap={layout.coverTitleGap}>
      <paragraph name="cover-eyebrow" width={hug} style={styles.coverEyebrow}>{eyebrow}</paragraph>
      <paragraph name="cover-title" width={wrap(layout.coverTitleMeasure)} style={styles.coverTitle}>
        {headline}
      </paragraph>
      <paragraph name="cover-promise" width={wrap(layout.coverPromiseMeasure)} style={styles.coverPromise}>
        {audiencePromise}
      </paragraph>
    </column>
    <row name="cover-meta" width={fill} height={hug} justify="between" align="end">
      {logoLockup}
      <paragraph name="cover-date" width={hug} style={styles.coverMeta}>{dateOrContext}</paragraph>
    </row>
  </box>,
);
```

The code above is a pattern, not a template. Move the type lockup, dominant element, and metadata to match the chosen archetype. For a type-led cover, the dominant element can be the title itself. For a data-led cover, the dominant element should be a single native number/chart fragment/artifact, not a KPI array. For an imagery-led cover, the image must be resolved before export and should occupy the decisive visual field.

Watch for these layout smells:

```tsx
// The slide is a giant panel with prose inside; this is not a designed slide.
slide.compose(
  <box name="main-panel" width={fill} height={fill} style={styles.bigPanel}>
    <paragraph name="body-copy" style={styles.body}>{paragraphText}</paragraph>
  </box>,
);

// Repeated cards are being used as the slide's grammar instead of a real visual form.
<grid name="card-grid" columns={[fr(1), fr(1), fr(1)]}>
  {items.map((item) => <box style={styles.card}><paragraph>{item.body}</paragraph></box>)}
</grid>

// Oversized empty metric tiles are filler, not premium whitespace.
<row name="price-cards" width={fill} height={fill}>
  {prices.map((price) => (
    <box width={grow(1)} height={fill} style={styles.blankCard}>
      <paragraph style={styles.bigNumber}>{price}</paragraph>
      <paragraph style={styles.tinyCaption}>{price.caption}</paragraph>
    </box>
  ))}
</row>

// Title and content are unrelated frames; content starts at a magic y-position.
slide.compose(<paragraph width={titleWidth} height={titleHeight} style={styles.title}>{title}</paragraph>, {
  frame: titleFrame,
});
slide.compose(<ContentGrid />, { frame: bodyFrame });

// Fixed title height is used without checking exported layout text metrics.
<paragraph name="slide-title" width={fill} height={fixedTitleHeight} style={styles.title}>
  {title}
</paragraph>

// `layers` owns the main content flow instead of only overlays, backgrounds, or deliberate art direction.
<layers name="everything" width={fill} height={fill}>{title}{body}{chart}{footer}</layers>
```

Name the variable text node itself, not just its parent scaffold. Use stable names such as `slide-title`, `hero-title`, `slide-subtitle`, `body-copy`, `callout-label`, and `source-rail` so exported `.layout.json` can target the exact text object. A layout with named parent regions but anonymous title/body paragraphs is not inspectable enough.

When a title, subtitle, callout, chip, or footer has variable text, prefer `height={hug}` or omitted text height inside a parent layout that can absorb growth. Use fixed text heights only after inspecting exported layout metrics for the named text node and confirming the text has room in the actual PPTX export path.

### Large Numbers, Labels, And Scoreboard Layouts

Large numerals and short labels are high-risk in PowerPoint because a tiny wrap or font substitution can make the label collide with the number. Treat every number-plus-label pair as one composed object, not as independent absolute frames.

- Put the large number, its label, and any related rule/axis/tick inside the same named `column`, `row`, or `grid` cell so spacing is owned by one parent.
- Do not place a label across a large numeral, or a large numeral behind a label, unless it is deliberately illegible background texture and a separate readable label exists.
- For one-line metric labels, set a generous measure, keep the label as a single run/string, and verify `textLayout.lineCount == 1`. If it wraps, widen the region, shorten the label, stack it intentionally, or move it away from the number.
- For oversized title or metric type, either reserve the full bbox in the composed layout or crop it only where no readable text, chart, table, source, or logo occupies the crop zone.
- In scoreboard, timeline, pathway, and scale compositions, build the score/label pairs first as named components, then place those components on the track. Do not draw the track and later scatter numbers and labels on top with magic coordinates.

For flows/processes/pathways, make the relationship the main visual object. Prefer lanes, loops, branches, gates, matrices, timelines, maps, or system geometry. Use arrows only when they clarify, and anchor connectors to named source/target elements.

Any absolute-positioned shape/box in a layered layout must declare explicit `width` and `height`. Do not set only `x`, `y`, and `width`; many layout primitives will stretch the missing dimension, producing giant off-slide pills, panels, or outlines.

For badges, counters, step numbers, icon tiles, and other small fixed-size marks, center both the child frame and the text inside the frame. `box align="center" justify="center"` only positions the paragraph object; it does not center the glyphs within that paragraph. Add `align: center` / `alignment: center` to the paragraph text style, keep the text frame slightly wider than the glyphs, and verify single-digit and multi-digit states in the exported PNG/layout JSON.

Avoid pill-shaped boxes as default chrome. If a pill/chip is necessary, give it a fixed height, one-line text, explicit vertical alignment, and enough width for the longest label; otherwise use plain text, a rule, or a rectangular label.

For compact one-line labels that combine dynamic values with suffixes or units, author the full label as a single string expression or an explicit single run. Do not place a JSX expression next to literal text when the label must stay on one line: use ``{`${discount}%`}`` instead of `{discount}%`, and ``{`${price} from ${list}`}`` instead of `{price} from {list}`. Adjacent JSX text nodes can be lowered into separate paragraphs/runs and wrap differently in PPTX.

Use `{ type: "none" }` for invisible fills/lines where supported. Do not use transparent hex strings like `#00000000`.

Do not use native PowerPoint placeholders for slide numbers, dates, footers, or title scaffolding. Slide numbers, when needed, must be normal authored footer text at the slide edge. Remove or avoid imported/default `sldNum` placeholders; visible placeholder prompts such as `Slide Number` are always broken output.

## 13. PPTX Text Compatibility

PowerPoint/Keynote may render text differently than Granola PNG export. Treat text as unsafe unless it has slack.

Treat microtext as a design failure even when it technically fits. Important exported text must be readable in the saved-PPTX slide view; if not, simplify, split the idea, enlarge the visual, shorten the copy, or rebuild the slide.

- Choose line spacing from the deck style, font metrics, and visual intent; do not treat one line-height number as universally safe. Tight display type is acceptable only when the named text node is inspected after export and nearby regions still have room.
- Never place multi-line text in a frame whose authored height is less than the layout/exported text height.
- For hero/title slides, reserve enough height for the actual wrapped line count plus one safety line before placing subtitles or metrics below.
- After export, inspect `.layout.json` for important text boxes. If `textLayout.height` is greater than the element bbox/frame height, or if the widest rendered line in `textLayout.lines[].width` is greater than the bbox/frame width, patch the JSX even if the PNG montage looks acceptable. Do not rely on top-level `textLayout.width` alone; it can report the assigned frame width rather than the rendered glyph width.
- Inspect important text by stable `name`, not just by counting text elements. Every title, subtitle, body/callout, footer/source rail, and one-line chip/badge that can vary must have a name in JSX and a corresponding layout-export check.
- For every title, callout, chip/badge, chart label, footer/source line, and compact metric, check that the exported `textLayout.lineCount` matches intent. A one-line label that becomes two lines is a failure even if the text still appears in the Granola PNG. The common fixes are rewrite shorter, give the label more width, lower the font size slightly, or intentionally stack the phrase in a taller composed text region with enough downstream spacing.
- Treat any text box with `textLayout.height > bbox.height` or `max(textLayout.lines[].width) > bbox.width` as unsafe unless it is a known zero-size invisible default artifact with no visible text and absent from exported OpenXML.
- Large titles need generous composed title regions. Prefer intrinsic/hug/omitted text heights inside a root `column`/`grid` title stack; use fixed paragraph heights only when the exported `textLayout` proves there is slack. Manual line breaks or separate title lines are acceptable when they stay inside the same composed title stack and reserve space before subtitles or metrics.
- Keep visible slack in title/body/callout regions that may wrap, and verify it from exported text layout and PPTX rendering instead of relying on a fixed percentage.
- Prefer shorter copy, wider frames, smaller font size, or separate fixed lines before using tight line spacing.
- Avoid stacking fixed-position text boxes based only on expected rendered height. Reserve macro rails/regions inside the root layout with enough room for PowerPoint font metrics, and let variable title/subtitle/body text size the stack unless a deliberate fixed frame has been verified.
- Use installed fonts, but assume the PPTX renderer may pick a different face/weight/metrics than Granola. More slack beats perfect-looking tight type.

### Slide Boundary And Spill Gate

Nothing important may spill outside the slide or be clipped by the exported viewport. Full-bleed backgrounds, intentional crop masks, and off-canvas decorative bleeds are allowed only when the important subject/text remains inside its planned safe area.

Before final delivery:

```text
slideBoundaryGate:
  importantElementsInsideCanvas: every title, subtitle, body block, chart/table, label, logo, source, footer, and page marker has bbox within 0..slideWidth and 0..slideHeight
  safeAreaRespect: non-bleed content stays inside the deck safe area or has a named intentional exception
  footerFit: source/footer/date/page text fits inside the reserved footer rail without clipping or crossing other content
  contentFitDecision: if content does not fit, reduce words, split the slide, move detail to notes/appendix, or redesign the layout
```

Do not accept a slide where a screenshot, chart, table, footer, caption, or source line is partially outside the frame, hidden below the slide, cropped by the preview, or visibly colliding with the slide edge. If a slide needs more content than it can hold at the legibility floor, the slide is overfull; redesign it instead of shrinking text.

## 14. Export And QA

Run the generated builder or test command from the setup-created workspace using the runtime Node executable reported by the setup script. Do not author or test from repository-internal package paths.

Render final slide PNG previews with Granola/artifact-tool. Inspect every slide individually at readable size, especially the title/subtitle rail, footer/source rail, pill/chip labels, and dense chart/table regions. Use montage/contact sheets only for rhythm. Do not accept a deck based on the montage alone.

Run a legibility and contrast pass on each rendered PNG:

```text
all live-read text is readable without zooming at full-size preview and still clear at typical presentation scale
normal-slide body/callout text is usually >= 24 pt; important labels >= 18 pt; chart/table labels >= 14 pt
source/footer text below 12 pt is visually quiet but not required for understanding the slide
no important text sits on a busy photo, gradient, or low-contrast field without a deliberate scrim, solid field, calmer crop, or stronger text color
if contrast/readability is uncertain by eye, treat it as a failure and patch the slide
```

Inspect slide 1 first and alone. It must pass the title-page design gate before the rest of the deck can be considered done:

```text
cover reads as a premium, prompt-specific title page at full size and thumbnail size
one dominant idea owns the page
title, audience promise, brand expression, and date/context have deliberate placement and hierarchy
no generic dashboard, KPI strip, 2x2 grid, hero-plus-card-rail, or content-slide scaffold
if type-led, typography/measure/negative space carry the cover without filler geometry
if imagery-led, the subject image/evidence object is real, resolved, relevant, and large enough to justify the cover
if data-led, there is one memorable number or distilled artifact, not a metric cluster
```

For `.pptx` delivery, do a PPTX parity check on title-heavy or text-dense decks with headless PPTX render/import tooling when available. The exported PPTX view is authoritative for wrapping, line spacing, vertical alignment, and placeholder behavior. Passing Granola PNGs or the montage alone is not enough; if PPTX parity cannot be checked, say so in the final response and rely on the layout/OpenXML checks below.

PPTX validation is blocking. Do not rely on Granola source-rendered PNGs or a montage as the final quality signal. After the deck is exported, reopen the saved .pptx with the best available headless PPTX/package/import tooling and inspect the saved deck itself. Use Granola/OpenXML package inspection, Presentation.load/inspect/export from the saved .pptx, or another PowerPoint-compatible headless render path available on the dev box.

Inspect every slide at full size. Verify that title/subtitle stacks do not overlap, title/body regions have at least 32 px of visible separation, text boxes are not clipped, fonts resolve to intentional installed families, and substituted fonts do not damage line breaks or hierarchy. Check all user-facing text, charts, tables, footers, source notes, and annotations. A slide fails QA if important text is technically present but visually unreadable. Title-slide copy must be short and content-appropriate, and the title page must feel intentionally designed without forced decorative chaos. Use layout metrics when available: textLayout.height must fit its bbox/frame, max rendered line width must fit, important text boxes must not intersect, and all intentional one-line labels/metrics must stay one line. Reject any slide where a metric label wraps into a large numeral, a title is clipped by its frame, or a decorative type overlap degrades readable copy.

When text reads too small, do not solve it by adding more instructions to the slide or by shrinking other content. Shorten copy, move source detail into a readable note, split dense evidence across slides, or make the chart/visual larger.

After any legibility repair, rerun overlap and clipping checks on the saved PPTX. Larger text is only acceptable when it still preserves clean title/body separation, fits its frame, and does not collide with charts, images, footers, or nearby annotations.

Also inspect layout artifacts for text overflow and text-box collisions:

```text
for important text elements, textLayout.height <= bbox/frame height
for important one-line elements, max(textLayout.lines[].width) <= bbox/frame width
for intentional one-line labels, textLayout.lineCount == 1
no unintended bbox intersections among title, subtitle, body, chips, footers, and source text
title/subtitle/body vertical gaps meet the deck's spacing rules after actual render
```

Inspect slide bounds and footer/source fit:

```text
all important element bboxes are inside the slide canvas unless intentionally full-bleed
all non-bleed content respects the safe area or has a named exception
no source/footer/caption/page marker crosses the slide edge, sits below the visible frame, or collides with content
no chart/table/image is clipped by its frame unless the crop is deliberate and preserves the subject
```

Inspect every chart/table data object against the deck design system:

```text
chart/table palette uses named deck tokens or justified semantic colors
chart/table typography matches deck font roles for labels, numerals, headers, body, and notes
chart structure makes the slide's one insight obvious without legend hunting
chart passes the sufficiency gate: enough points/categories/series/context for the visual form, or it is replaced by a better non-chart treatment
axes, gridlines, rules, fills, labels, chips, and annotations are deliberate and on-theme
no default Office/Excel chart colors, generic chart fills, stock table headers, heavy grids, or cramped cells
no overlapping chart labels, clipped data labels, duplicate legends, unreadable ticks, or wrapped one-line chips
```

Inspect exported PPTX/proto/package artifacts for leftover placeholders. Fail and scrub before final delivery if any visible placeholder text or native slide-number placeholder remains, especially `Slide Number` or `placeholderType: "sldNum"`. If `.layout.json` reports a zero-size default placeholder, verify it has no visible text and that OpenXML contains no `sldNum`, `Slide Number`, or visible placeholder prompt before treating it as benign.

Patch source JSX and rerun. Stop after 3 render/fix loops unless the user asks to continue.

Run a final deck-level QA pass across the whole deliverable:

```text
content maturity fit, audience fit, tone/palette/structure alignment, formatPromise fulfillment,
text economy, open text strategy, container abstinence, reading load, hierarchy, spacing, structure consistency, progression necessity/clarity, controlled archetype use, image integration, evidence fit,
motif consistency, deck design system adherence, export safety
```

Blocking defects:

- tone/content maturity mismatch, such as a silly, fandom, classroom, party, or entertainment prompt rendered as a sober work deck without a deliberate comic premise
- palette/formality mismatch, such as executive navy, tiny source-footnote energy, boardroom typography, or consulting chrome on a playful deck
- palette with no stated source, no named token roles, or no relationship to the audience, subject world, brand, format metaphor, data semantics, or key image assets
- palette chosen as a flat swatch set without role assignments, locked anchors, contrast relationships, and at least three candidate directions for creative/playful decks
- palette for a non-branded deck chosen only by "nice colors" language, with no emotional/format anchor and no on-slide role test
- gradients used as the primary style move across the deck instead of solid planes, typography, image crops, data styling, layout, or subject imagery
- creative/playful deck where saturated color exists only in small chips, labels, or footers instead of major fields, image framing, expressive typography, chart/table styling, or repeated motif behavior
- creative/playful deck that fails the thumbnail test: when viewed as a contact sheet, the deck reads as mostly dark/gray/neutral and low-energy despite a fun, fandom, party, classroom, or entertainment prompt
- colors that fight the imagery, make subject images feel pasted on, muddy vibrant assets, or use unrelated muted bars/overlays around high-recognition characters or products
- arbitrary rainbow color, one-note hue families, or too many equal-strength accents when a smaller controlled palette would make the deck clearer
- chart/table design mismatch, such as default Office/Excel colors, off-theme table fills, generic black headers, unstyled body text, cramped rows, heavy grids, duplicate legends, illegible ticks, or data labels that collide with the evidence
- structure mismatch, such as a rubric, scorecard, table, dashboard, or panel grid chosen by habit instead of because it fits the audience and topic
- title page that reads as a dashboard opener, content slide, KPI-card cluster, 2x2 grid, hero-plus-card rail, or generic title-plus-panels layout
- title page built by reusing the normal content slide shell instead of a dedicated cover concept from `titlePageConcept`
- title page with more than one equal-weight claim, chart, data cluster, or visual idea competing for first read
- title page that is not prompt-specific enough: it would still look acceptable after swapping in a different company, sector, event, product, or person
- type-led title page where the type, measure, spacing, and negative space do not carry the design
- imagery-led title page with unresolved, generic, decorative, too-small, or irrelevant imagery
- data-led title page that uses a strip/grid of metrics instead of one memorable number or distilled evidence artifact
- creative deck using only safe grids/cards when the prompt calls for visual energy and the content could support slants, crops, masked images, asymmetric type, editorial spreads, or artifact-like layouts
- decorative-only native geometry such as blobs, orbs, filler badges, random diagonals, or arbitrary shapes that do not carry composition, data, masking, hierarchy, or artifact form
- image-use mismatch, such as subject images that look pasted on, too small, unrelated, purely decorative, or unable to explain why they belong on that slide
- image fit/scale mismatch, such as stretched assets, accidental cover crops, clipped labels/faces/products/diagrams, tiny unreadable screenshots, low-resolution blowups, or inconsistent scale across repeated evidence objects
- copy that is too sterile, abstract, or corporate for a playful audience when the premise invites warmer, funnier, or more characterful language
- non-appendix slides that read like research pages, dashboards, or source dumps instead of live presentation slides
- any non-appendix slide where prose or bullets are placed inside a big visible box without an explicit user-requested artifact form
- any slide dominated by a large visible rectangle/card/panel/block when the content could be open typography, a chart/table, a diagram, an image-led explanation, speaker notes, or a split slide
- giant mostly empty cards or tiles used as whitespace, especially price/metric cards with a number at the top and tiny caption near the bottom
- repeated boxes, blocks, square tiles, boxed paragraph panels, or card grids used as the default visual template without a real comparative, artifact, UI, reference, or operational reason
- "title + three boxes/cards" as a recurring scaffold unless the user explicitly asked for that structure or the slide brief justifies it as a real modular comparison
- more than one main job on a slide without a deliberate split or staged hierarchy
- no dominant visual/data/text object, or too many equal-weight components competing for first read
- rich data presented as many small undifferentiated boxes when a ranked, grouped, annotated, or appendix treatment would be clearer
- data-rich, investor, earnings, market, operating, scientific, or benchmark decks with chartable evidence but no native `<chart>` or `<table>` nodes
- one-point or two-endpoint charts used as if they were rich evidence, especially a single-series line connecting one point to one point with no benchmark, history, annotation, or delta treatment
- line/area charts with fewer than 4 periods unless explicitly justified as a before/after slopegraph with context, direct labels, and a dominant delta
- charts that use a large plot area for one number, two values, or a subtraction problem that would read better as open metric typography, a paired comparison, a compact table, or an annotated sentence
- ordinary bar, line, combo, waterfall, pie/doughnut, scatter/bubble, funnel, histogram, treemap, or table views rebuilt from boxes/shapes without an explicit slide-brief reason
- blank/missing images
- wrong image aspect ratio, accidental cover crop, or clipped subject/labels
- title/body collisions
- title/subtitle overlap or any unintended text-on-text collision
- PPTX render wrapping/spacing differs from Granola preview enough to cause collision, clipping, or visual degradation
- work title wrapping without intent
- less than 0.3 in / 32 px between title/subtitle and first body object
- footer/source collisions
- overflow/clipping
- any important content, source/footer text, chart, table, image, label, logo, page marker, or caption spilling outside the slide canvas or sitting below the visible frame
- footer/source text that runs past its reserved rail, overlaps content, or requires unreadably tiny type to fit
- overfull slides where the correct fix is splitting, cutting, moving detail to notes/appendix, or redesigning the layout, but the JSX instead lets content clip or spill
- low contrast, especially text over photos, gradients, or busy backgrounds without a deliberate readability treatment
- tiny filler text, required reading below the legibility floor, or any text that needs zooming to read in the rendered PNG
- uneven repeated spacing
- misalignment
- inconsistent logo placement, size, or clearspace across normal slides
- progress systems that are unnecessary, visually overwhelming, website-like sidebars/nav rails, or move backward/confuse deck order
- generic repeated segmented-bar progress indicators, corner bead/status rows, or decorative step blocks instead of a custom deck-native device
- off-slide or accidentally oversized shapes/boxes from missing explicit dimensions
- pill/chip text that is clipped, crowded, off-center, or used as decoration
- default-looking charts/tables, including stock native table styles that have not been redesigned into the deck's visual system
- unresolved, fake, generic, repeated, decorative, or montage-style raster/shape assets instead of real subject imagery
- educational/scientific decks whose subject assets do not meet the clean modern textbook illustration standard
- complex subject imagery created from SVGs, Canvas/OffscreenCanvas, JSX/native shapes, HTML/CSS screenshots, or procedural geometry, even if saved as `.png`
- screenshots/pages from source documents used as assets instead of rebuilt content
- visible placeholder text or native slide-number placeholders (`Slide Number`, `sldNum`)
- unreadable data labels
- unclear/floating arrows
- missing diagram marks
- fake/irrelevant imagery
- accidental meta text such as "generated with", "built-in image tool", "native chart object", "itinerary research", or "this deck"

Do not choose between rendered previews and layout output. Full-size saved-PPTX renders are the visual source of truth, and exported layout/OpenXML checks are binding for text fit, clipping, one-line labels, and collisions. If either the visual render or the layout metrics show a failure, patch the JSX and rerun QA.

## Final Response

Include:

```text
test command
exported deck path
preview/render paths
whether PNGs were inspected
whether PPTX parity was checked
intentional exceptions or unresolved issues
```

Do not claim external PowerPoint/Keynote parity.
