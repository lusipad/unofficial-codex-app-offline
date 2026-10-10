"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "../..");
const loadProbe = () =>
  import(pathToFileURL(path.join(repoRoot, "scripts", "offline-feature-probe.mjs")).href);

// 26.1007 settings-page navigation shapes: a split string, a plain heading
// reference, and a message call heading with nested braces.
const settingsPageChunk = {
  name: "settings-page-aaaa.js",
  content:
    "let g=[{key:`settings`,heading:null,slugs:[...e.slugs.filter(e=>e!==`agreements`),`agreements`]}," +
    "{key:`personal`,heading:null,slugs:`general-settings.appearance.keyboard-shortcuts.billing.debug`.split(`.`)}," +
    "{key:`integrations`,heading:Qr,slugs:[`plugins-settings`,`appshots`,`mcp-settings`]}," +
    "{key:`coding`,heading:_e({id:`settings.nav.heading.coding`,defaultMessage:`Coding`}),slugs:[`worktrees`,`cloud-settings`]}];",
};

const expectations = {
  mode: "api-key",
  alwaysVisible: ["general-settings", "appearance"],
  expectVisible: ["appshots"],
  expectHidden: ["billing"],
  notes: {
    billing: { label: "账单", reason: "上游当前对所有用户隐藏" },
    "mcp-settings": { label: "MCP 服务器", reason: "已合并到「插件」页面" },
  },
};

const visible = [
  { slug: "general-settings", label: "常规" },
  { slug: "appearance", label: "外观" },
  { slug: "keyboard-shortcuts", label: "键盘快捷键" },
  { slug: "plugins-settings", label: "插件" },
  { slug: "appshots", label: "应用快照" },
  { slug: "worktrees", label: "Worktrees" },
];

test("feature probe extracts every settings navigation group shape", async () => {
  const { extractSettingsNavigation } = await loadProbe();
  const groups = extractSettingsNavigation([settingsPageChunk]);
  assert.deepEqual(groups.map((group) => group.key), ["personal", "integrations", "coding"]);
  assert.deepEqual(groups[0].slugs, ["general-settings", "appearance", "keyboard-shortcuts", "billing", "debug"]);
  assert.deepEqual(groups[2].slugs, ["worktrees", "cloud-settings"]);
});

test("feature probe rejects a run it cannot trust", async () => {
  const { checkProbe } = await loadProbe();
  // No static navigation found: nothing visible can be placed.
  let result = checkProbe({ staticGroups: [], visible, expectations });
  assert.match(result.problems.join("\n"), /static settings navigation not found/);
  assert.match(result.problems.join("\n"), /"appshots" is not in the static navigation/);

  const staticGroups = Array.from({ length: 25 }, (_, i) => ({ key: "pad", slugs: [`pad-${i}`] }))
    .concat([{ key: "personal", slugs: ["general-settings", "appearance", "keyboard-shortcuts", "billing"] },
      { key: "integrations", slugs: ["plugins-settings", "appshots", "mcp-settings", "worktrees"] }]);
  // A page that has not loaded yet misses the always-present sections.
  result = checkProbe({ staticGroups, visible: [{ slug: "appshots", label: "应用快照" }], expectations });
  assert.match(result.problems.join("\n"), /always-present section "general-settings" is not visible/);

  result = checkProbe({ staticGroups, visible, expectations });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.contradictions, []);
  // Hidden sections without a note are flagged for the maintainer.
  assert.ok(result.warnings.some((warning) => /"pad-0" has no note/.test(warning)));

  // UI-confirmed expectations are asserted both ways.
  result = checkProbe({
    staticGroups,
    visible: visible.filter((item) => item.slug !== "appshots").concat([{ slug: "billing", label: "账单" }]),
    expectations,
  });
  assert.deepEqual(result.contradictions, [
    'expected visible: "appshots" is hidden',
    'expected hidden: "billing" is visible',
  ]);
  assert.ok(result.warnings.includes('note for "billing" is stale: the section is visible'));
});

test("feature report labels visible sections from the UI and hidden ones from notes", async () => {
  const { extractSettingsNavigation, buildFeatureReport, renderFeatureMarkdown } = await loadProbe();
  const staticGroups = extractSettingsNavigation([settingsPageChunk]);
  const report = buildFeatureReport({ staticGroups, visible, expectations, version: "26.1007.2314.0" });
  const sections = new Map(report.groups.flatMap((group) => group.sections).map((s) => [s.slug, s]));
  assert.deepEqual(sections.get("appshots"), { slug: "appshots", visible: true, label: "应用快照", reason: null });
  assert.deepEqual(sections.get("billing"),
    { slug: "billing", visible: false, label: "账单", reason: "上游当前对所有用户隐藏" });
  assert.deepEqual(sections.get("debug"), { slug: "debug", visible: false, label: null, reason: null });

  const markdown = renderFeatureMarkdown(report);
  assert.match(markdown, /\| 应用快照 \(`appshots`\) \| ✅ \|  \|/);
  assert.match(markdown, /\| 账单 \(`billing`\) \| — \| 上游当前对所有用户隐藏 \|/);
  assert.match(markdown, /\| `debug` \| — \| 待说明 \|/);
});

test("committed feature expectations are consistent", () => {
  const data = require(path.join(repoRoot, "scripts", "offline-feature-expectations.json"));
  const visibleSet = new Set([...data.alwaysVisible, ...data.expectVisible]);
  for (const slug of data.expectHidden) assert.ok(!visibleSet.has(slug), `${slug} is expected both ways`);
  for (const slug of visibleSet) assert.ok(!data.notes[slug], `${slug} is expected visible but has a hidden note`);
  for (const note of Object.values(data.notes)) {
    assert.ok(note.label && note.reason, "every note needs a label and a reason");
  }
});

function featureReport(version, sections) {
  return { schemaVersion: 1, version, mode: "api-key", groups: [{ key: "integrations", sections }] };
}

test("release snippet lists only changes and collapses long lists", async () => {
  const { diffFeatures, renderReleaseSnippet } = await loadProbe();
  const url = "https://example.test/docs/offline-features.md";
  const baseline = featureReport("26.1002", [
    { slug: "appshots", visible: false, label: "应用快照", reason: "原因待确认" },
    { slug: "pets", visible: true, label: "Mini 与虚拟宠物", reason: null },
    { slug: "old", visible: false, label: "旧分区", reason: "x" },
  ]);
  // Unchanged → nothing in the release notes.
  assert.equal(renderReleaseSnippet(diffFeatures(baseline, baseline), url), "");
  assert.equal(renderReleaseSnippet(null, url), "");

  const current = featureReport("26.1007", [
    { slug: "appshots", visible: true, label: "应用快照", reason: null },
    { slug: "pets", visible: false, label: "Mini 与虚拟宠物", reason: null },
    { slug: "new-one", visible: false, label: null, reason: null },
  ]);
  const diff = diffFeatures(baseline, current);
  assert.deepEqual(
    [diff.nowVisible, diff.nowHidden, diff.added, diff.removed].map((list) => list.map((s) => s.slug)),
    [["appshots"], ["pets"], ["new-one"], ["old"]],
  );
  const snippet = renderReleaseSnippet(diff, url);
  assert.match(snippet, /^## 离线功能变化 \/ Offline feature changes\n/);
  assert.match(snippet, /相对 26\.1002/);
  assert.match(snippet, /- 新增可见：应用快照\n/);
  assert.match(snippet, /- 不再可见：Mini 与虚拟宠物（原因待确认）\n/);
  assert.match(snippet, /- 新增设置分区：new-one（离线不可见）\n/);
  assert.match(snippet, /- 上游移除：旧分区\n/);
  assert.match(snippet, /完整清单：https:\/\/example\.test/);

  const many = featureReport("26.1007", Array.from({ length: 7 }, (_, i) =>
    ({ slug: `s${i}`, visible: true, label: `分区${i}`, reason: null })));
  const collapsed = renderReleaseSnippet(diffFeatures(featureReport("26.1002", []), many), url);
  assert.match(collapsed, /- 共 7 项变化，详见完整清单。/);
  assert.doesNotMatch(collapsed, /分区0/);
});

test("committed feature baseline and user document stay in sync", async () => {
  const fs = require("node:fs");
  const { renderUserDocument } = await loadProbe();
  const baseline = require(path.join(repoRoot, "docs", "baselines", "offline-features.json"));
  const doc = fs.readFileSync(path.join(repoRoot, "docs", "offline-features.md"), "utf8");
  assert.equal(doc, renderUserDocument(baseline), "regenerate with --promote instead of editing by hand");
  for (const section of baseline.groups.flatMap((group) => group.sections)) {
    assert.ok(section.visible || section.reason, `${section.slug} is hidden without a reason`);
  }
});
