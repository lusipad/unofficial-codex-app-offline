# Artifact Tool Presentation JSX Reference

Use the bundled `@oai/artifact-tool` package as the import surface. In current runtimes, it exposes the presentation model, compose helpers, and `@oai/artifact-tool/presentation-jsx` JSX runtime subpaths. Do not bypass the bundled artifact-tool surface with lower-level package paths.

## Minimal Module

```tsx
/** @jsxRuntime automatic */
/** @jsxImportSource @oai/artifact-tool/presentation-jsx */

const {
  Presentation,
  PresentationFile,
  row,
  column,
  grid,
  layers,
  panel,
  text,
  image,
  shape,
  chart,
  table,
  rule,
  fill,
  hug,
  fixed,
  wrap,
  grow,
  fr,
  auto,
} = await import("@oai/artifact-tool");
const { Fragment, paint, stroke, textStyle } = await import(
  "@oai/artifact-tool/presentation-jsx"
);

const presentation = Presentation.create({
  slideSize: { width: 1920, height: 1080 },
});

const slide = presentation.slides.add();
slide.compose(
  column(
    { name: "root", width: fill, height: fill, padding: 72, gap: 28 },
    [
      text("Quarterly readiness", {
        name: "headline",
        width: fill,
        height: hug,
        style: { fontSize: 64, bold: true, color: "#0F172A" },
      }),
      rule({ name: "headline-rule", width: fixed(220), stroke: "#2563EB", weight: 4 }),
      text("A composed title stack reserves space before body content.", {
        name: "subtitle",
        width: wrap(940),
        height: hug,
        style: { fontSize: 30, color: "#475569" },
      }),
    ],
  ),
  {
    frame: { left: 0, top: 0, width: 1920, height: 1080 },
    baseUnit: 8,
  },
);

const pptxBlob = await PresentationFile.exportPptx(presentation);
await pptxBlob.save("output/output.pptx");
```

## Sizing

- `fixed(320)` or raw numbers for exact pixels.
- `fill` consumes available space.
- `hug` sizes to intrinsic content.
- `wrap(560)` sizes to intrinsic content capped at a max.
- `grow(n)` is weighted fill on the stack axis.
- `fr(n)` is a grid fraction track.
- `auto` is an intrinsic grid track.

## Compose Helpers

### Root Layout

Use one composed root for the slide's readable content:

```js
slide.compose(
  grid(
    {
      name: "slide-root",
      width: fill,
      height: fill,
      columns: [fr(1.2), fr(0.8)],
      rows: [auto, fr(1), auto],
      columnGap: 48,
      rowGap: 32,
      padding: { x: 80, y: 64 },
    },
    [
      column(
        { name: "title-stack", width: fill, height: hug, gap: 16, columnSpan: 2 },
        [
          text("ServiceNow's AI posture is control, not point-solution sprawl", {
            name: "slide-title",
            width: fill,
            height: hug,
            style: { fontSize: 58, bold: true, color: "#EAF7F1" },
          }),
          text("The platform story works when governance, workflow execution, and AI surfaces are composed together.", {
            name: "slide-subtitle",
            width: wrap(1280),
            height: hug,
            style: { fontSize: 25, color: "#B9D7CC" },
          }),
        ],
      ),
      text("What sets the platform apart", {
        name: "large-left-claim",
        width: fill,
        height: hug,
        style: { fontSize: 64, bold: true, color: "#FFFFFF" },
      }),
      column(
        { name: "proof-list", width: fill, height: fill, gap: 20 },
        [
          panel({ name: "proof-1", padding: { x: 28, y: 22 }, borderRadius: "rounded-full" },
            text("AI in the flow of work, not in another tool", { width: fill, height: hug, style: { fontSize: 25, bold: true } })),
          panel({ name: "proof-2", padding: { x: 28, y: 22 }, borderRadius: "rounded-full" },
            text("Enterprise AI, not application AI", { width: fill, height: hug, style: { fontSize: 25, bold: true } })),
        ],
      ),
      text("Source: company materials.", {
        name: "source",
        columnSpan: 2,
        width: fill,
        height: hug,
        style: { fontSize: 12, color: "#9FB7AF" },
      }),
    ],
  ),
  { frame: { left: 0, top: 0, width: 1920, height: 1080 }, baseUnit: 8 },
);
```

### Text

Use `text(value, options)` for editable text. For variable text, prefer `height: hug` or omit `height`.

```js
text("A short, audience-facing claim", {
  name: "claim",
  width: wrap(900),
  height: hug,
  style: {
    fontSize: 48,
    bold: true,
    color: "#101214",
  },
});
```

Rich text can use structured input when needed:

```js
text(
  [
    [
      { run: "Revenue", textStyle: { bold: true } },
      { run: " improved while margin expanded", textStyle: { color: "#475569" } },
    ],
  ],
  { name: "rich-callout", width: fill, height: hug, style: { fontSize: 30 } },
);
```

### Images

Use real image files or blobs for subject imagery. Keep labels and copy native/editable.

```js
image({
  name: "product-shot",
  path: "scratch/assets/product.png",
  width: fill,
  height: fill,
  fit: "cover",
  alt: "Product screenshot",
});
```

If the image helper needs a blob, read the bytes in the deck script and pass a blob/source supported by the runtime. Keep generated images in `scratch/`, not `output/`.

### Charts And Tables

Use native editable chart/table nodes when they fit the data relationship:

```js
chart({
  name: "growth-chart",
  chartType: "bar",
  width: fill,
  height: fill,
  config: {
    title: { text: "Growth by segment" },
    categories: ["Enterprise", "Commercial", "Self-serve"],
    series: [{ name: "ARR", values: [42, 28, 16] }],
  },
});
```

For custom table styling that native table presets cannot handle, build an authored editable table from `grid`, `row`, `column`, `text`, `rule`, and `shape`.

## Layout Rules

- Major readable regions should share one root layout.
- Text that can wrap must live in a parent layout that absorbs the growth.
- Use `layers` for background art, crop fields, and overlays, not normal title/body flow.
- Avoid unrelated fixed text boxes for title, subtitle, body, and footer.
- Use fixed dimensions only for truly fixed marks or after verifying layout slack.
- Name key nodes for inspection: `slide-title`, `subtitle`, `source`, `chart-main`, `table-main`, `metric-label-*`.

## Output Hygiene

Write only the final deck to `output/output.pptx`. Keep source code, assets, rendered previews, reports, layout exports, and logs under `src/` or `scratch/`.
