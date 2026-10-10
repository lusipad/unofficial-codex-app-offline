#!/usr/bin/env node
/**
 * offline-feature-probe.mjs
 *
 * Lists which official Settings sections the offline package actually shows,
 * so users can tell which features are available offline and maintainers can
 * see what a new Store version changed. Windows-only, like the launch smoke.
 *
 *   static set   every settings navigation slug the unpatched bundle defines
 *                (settings-page navigation groups inside app.asar);
 *   runtime set  the slugs the packaged app renders (`data-settings-panel-slug`)
 *                after launching it with an API-key auth.json, no ChatGPT login,
 *                and the network blocked;
 *   missing      static − runtime.
 *
 * The probe checks itself before reporting anything: the static set must be
 * found, every visible slug must belong to it, a few always-present sections
 * must be visible, and the navigation must read the same twice in a row after
 * it settles. Expectations confirmed in the UI (scripts/offline-feature-
 * expectations.json) are asserted too. Any failure exits non-zero.
 *
 * Usage:
 *   node scripts/offline-feature-probe.mjs --portable-root <dir> --out-dir <dir>
 *        [--work-root <dir>] [--version <x>] [--timeout-ms 90000]
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const BASELINE_PATH = path.join(repoRoot, 'docs', 'baselines', 'offline-features.json');
const USER_DOC_PATH = path.join(repoRoot, 'docs', 'offline-features.md');
const MAIN_EXECUTABLE_NAME = 'ChatGPT.exe';
const MAIN_WINDOW_URL = 'app://-/index.html';
const SETTINGS_ROUTE_URL = `${MAIN_WINDOW_URL}?initialRoute=%2Fsettings%2Fgeneral-settings`;
const STATIC_SLUG_MIN = 20;
const STABLE_READS = 3;
const READ_INTERVAL_MS = 1_500;

// `{key:"personal",heading:…,slugs:[…]}` or `slugs:"a.b.c".split(".")`; the
// heading is often a message call with one level of `{…}` inside.
const NAV_GROUP_RE =
  /\{key:[`"']([\w-]+)[`"'],heading:(?:[^{}]|\{[^{}]*\})*?slugs:(\[(?:\s*[`"'][\w-]+[`"']\s*,?)+\]|[`"'][\w.-]+[`"']\.split\([`"']\.[`"']\))\}/g;

export function extractSettingsNavigation(files) {
  const groups = [];
  for (const file of files) {
    for (const match of file.content.matchAll(NAV_GROUP_RE)) {
      const raw = match[2];
      const slugs = raw.startsWith('[')
        ? [...raw.matchAll(/[`"']([\w-]+)[`"']/g)].map((m) => m[1])
        : raw.slice(1, raw.indexOf(raw[0], 1)).split('.');
      groups.push({ key: match[1], slugs });
    }
  }
  return groups;
}

export function checkProbe({ staticGroups, visible, expectations }) {
  const problems = [];
  const staticSlugs = new Set(staticGroups.flatMap((group) => group.slugs));
  if (staticSlugs.size < STATIC_SLUG_MIN) {
    problems.push(`static settings navigation not found (only ${staticSlugs.size} slugs)`);
  }
  const visibleSlugs = new Set(visible.map((item) => item.slug));
  if (visibleSlugs.size === 0) problems.push('no settings section was visible');
  for (const slug of visibleSlugs) {
    if (!staticSlugs.has(slug)) problems.push(`visible section "${slug}" is not in the static navigation`);
  }
  for (const slug of expectations.alwaysVisible) {
    if (!visibleSlugs.has(slug)) problems.push(`always-present section "${slug}" is not visible (page not loaded?)`);
  }
  const contradictions = [];
  for (const slug of expectations.expectVisible) {
    if (!visibleSlugs.has(slug)) contradictions.push(`expected visible: "${slug}" is hidden`);
  }
  for (const slug of expectations.expectHidden) {
    if (visibleSlugs.has(slug)) contradictions.push(`expected hidden: "${slug}" is visible`);
  }
  // Maintenance hints only: they keep the notes in step with the bundle.
  const warnings = [];
  for (const slug of [...expectations.alwaysVisible, ...expectations.expectVisible, ...expectations.expectHidden]) {
    if (staticSlugs.size >= STATIC_SLUG_MIN && !staticSlugs.has(slug)) {
      warnings.push(`expectation "${slug}" is no longer in the static navigation`);
    }
  }
  for (const slug of staticSlugs) {
    const note = expectations.notes[slug];
    if (!visibleSlugs.has(slug) && !note && slug !== 'settings') warnings.push(`hidden section "${slug}" has no note`);
    if (visibleSlugs.has(slug) && note) warnings.push(`note for "${slug}" is stale: the section is visible`);
  }
  return { problems, contradictions, warnings };
}

export function buildFeatureReport({ staticGroups, visible, expectations, version }) {
  const labels = new Map(visible.map((item) => [item.slug, item.label]));
  const seen = new Set();
  const groups = staticGroups
    .filter((group) => group.key !== 'settings')
    .map((group) => ({
      key: group.key,
      sections: group.slugs
        .filter((slug) => !seen.has(slug) && seen.add(slug))
        .map((slug) => {
          const note = expectations.notes[slug] ?? {};
          return {
            slug,
            visible: labels.has(slug),
            label: labels.get(slug) ?? note.label ?? null,
            reason: labels.has(slug) ? null : note.reason ?? null,
          };
        }),
    }));
  return { schemaVersion: 1, version: version ?? null, mode: expectations.mode, groups };
}

const GROUP_TITLES = { personal: '个人', teams: '团队', integrations: '集成', coding: '编码' };

const RELEASE_ITEM_LIMIT = 5;
const MODE_TEXT = { 'api-key': 'API Key / 未登录 ChatGPT，网络已阻断' };

function sectionTables(report, heading = '###') {
  const lines = [];
  for (const group of report.groups) {
    lines.push(`${heading} ${GROUP_TITLES[group.key] ?? group.key}`, '', '| 设置项 | 离线可见 | 说明 |', '| --- | --- | --- |');
    for (const section of group.sections) {
      const name = section.label ? `${section.label} (\`${section.slug}\`)` : `\`${section.slug}\``;
      const reason = section.visible ? '' : section.reason ?? '待说明';
      lines.push(`| ${name} | ${section.visible ? '✅' : '—'} | ${reason} |`);
    }
    lines.push('');
  }
  return lines;
}

// Maintainer view: the probe result plus what changed against the baseline.
export function renderFeatureMarkdown(report, diff = null) {
  const lines = [
    `## 离线功能清单 ${report.version ?? ''}`.trimEnd(),
    '',
    `模式：${MODE_TEXT[report.mode] ?? report.mode}。仅统计设置导航中的分区。`,
    '',
  ];
  const changes = releaseItems(diff);
  if (diff) {
    lines.push(`### 相对 ${diff.baselineVersion} 的变化`, '', ...(changes.length ? changes : ['无变化。']), '');
  }
  return [...lines, ...sectionTables(report)].join('\n');
}

// User-facing document, generated from the reviewed baseline.
export function renderUserDocument(report) {
  return [
    '# 离线功能清单',
    '',
    '<!-- 由 scripts/offline-feature-probe.mjs --promote 生成，请勿手工编辑；不可见原因在 scripts/offline-feature-expectations.json 中维护。 -->',
    '',
    `本清单在 **${report.version}** 离线包上实测生成，读取「设置」导航中实际显示的分区。` +
      `启动方式：${MODE_TEXT[report.mode] ?? report.mode}。`,
    '',
    '- ✅ 离线可用：设置中可见。',
    '- — 离线不可见：「说明」列给出原因。',
    '',
    '登录 ChatGPT 账号后可见的分区会更多（例如「使用情况和计费」「云端偏好设置」），本清单暂未覆盖。' +
      '左侧导航栏、编辑器按钮等其他入口也暂未覆盖。',
    '',
    ...sectionTables(report, '##'),
  ].join('\n');
}

export function toFeatureBaseline(report) {
  return { schemaVersion: 1, version: report.version, mode: report.mode, groups: report.groups };
}

export function diffFeatures(baseline, report) {
  if (!baseline) return null;
  const flatten = (data) => new Map(data.groups.flatMap((group) => group.sections).map((s) => [s.slug, s]));
  const before = flatten(baseline);
  const after = flatten(report);
  const diff = { baselineVersion: baseline.version, nowVisible: [], nowHidden: [], added: [], removed: [] };
  for (const [slug, section] of after) {
    const previous = before.get(slug);
    if (!previous) diff.added.push(section);
    else if (section.visible && !previous.visible) diff.nowVisible.push(section);
    else if (!section.visible && previous.visible) diff.nowHidden.push(section);
  }
  for (const [slug, section] of before) if (!after.has(slug)) diff.removed.push(section);
  return diff;
}

function releaseItems(diff) {
  if (!diff) return [];
  const name = (section) => section.label ?? section.slug;
  return [
    ...diff.nowVisible.map((s) => `- 新增可见：${name(s)}`),
    ...diff.nowHidden.map((s) => `- 不再可见：${name(s)}（${s.reason ?? '原因待确认'}）`),
    ...diff.added.map((s) => `- 新增设置分区：${name(s)}（${s.visible ? '离线可见' : '离线不可见'}）`),
    ...diff.removed.map((s) => `- 上游移除：${name(s)}`),
  ];
}

// Release notes carry only the changes: nothing when there are none, a count
// instead of a list when there are many.
export function renderReleaseSnippet(diff, docsUrl) {
  const items = releaseItems(diff);
  if (items.length === 0) return '';
  return [
    '## 离线功能变化 / Offline feature changes',
    '',
    `相对 ${diff.baselineVersion}，「设置」中的分区（API Key / 未登录模式）：`,
    '',
    ...(items.length > RELEASE_ITEM_LIMIT ? [`- 共 ${items.length} 项变化，详见完整清单。`] : items),
    '',
    `完整清单：${docsUrl}`,
    '',
  ].join('\n');
}

function readAsarJs(asarPath) {
  const asar = require('@electron/asar');
  return asar.listPackage(asarPath)
    .filter((entry) => /^[\\/]?webview[\\/]assets[\\/][^\\/]+\.js$/.test(entry))
    .map((entry) => ({
      name: path.basename(entry),
      content: asar.extractFile(asarPath, entry.replace(/^[\\/]/, '')).toString('utf8'),
    }));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function evaluate(port, url, expression) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((target) => target.type === 'page' && target.url === url);
  if (!page) return { missing: true };
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
    const message = await new Promise((resolve) =>
      ws.addEventListener('message', (event) => resolve(JSON.parse(event.data)), { once: true }));
    return { value: message.result?.result?.value };
  } finally {
    ws.close();
  }
}

const READ_SECTIONS = `[...document.querySelectorAll('[data-settings-panel-slug]')]
  .map((e) => ({ slug: e.getAttribute('data-settings-panel-slug'), label: e.getAttribute('aria-label') }))`;

async function readVisibleSections(port, deadline) {
  // Wait for the main window, open Settings, then wait for the navigation to
  // stop changing: sections whose gates are still loading render as pending.
  while (Date.now() < deadline) {
    try {
      const home = await evaluate(port, MAIN_WINDOW_URL, `document.readyState`);
      if (home.value === 'complete') break;
    } catch {}
    await delay(1_000);
  }
  await delay(5_000);
  await evaluate(port, MAIN_WINDOW_URL, `location.href = ${JSON.stringify(SETTINGS_ROUTE_URL)}, 'ok'`).catch(() => {});
  let previous = null;
  let stable = 0;
  while (Date.now() < deadline) {
    await delay(READ_INTERVAL_MS);
    let current;
    try {
      current = (await evaluate(port, SETTINGS_ROUTE_URL, READ_SECTIONS)).value;
    } catch {
      continue;
    }
    if (!Array.isArray(current) || current.length === 0) continue;
    const key = JSON.stringify(current);
    stable = key === previous ? stable + 1 : 1;
    previous = key;
    if (stable >= STABLE_READS) return current;
  }
  throw new Error('settings navigation did not settle before the timeout');
}

function killProcessTree(pid) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {}
}

async function launchAndRead({ appExe, workRoot, timeoutMs, lang }) {
  const userData = path.join(workRoot, 'user-data');
  const codexHome = path.join(workRoot, '.codex');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  // API-key mode without a ChatGPT login, past the first-run onboarding.
  fs.writeFileSync(path.join(codexHome, 'auth.json'),
    JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-offline-feature-probe' }));
  fs.writeFileSync(path.join(codexHome, '.codex-global-state.json'),
    JSON.stringify({ 'electron-persisted-atom-state': { 'electron:onboarding-projectless-completed': true } }));
  const port = await freePort();
  const out = fs.openSync(path.join(workRoot, 'codex-stdout.log'), 'w');
  const err = fs.openSync(path.join(workRoot, 'codex-stderr.log'), 'w');
  const child = spawn(appExe, [
    `--user-data-dir=${userData}`,
    `--remote-debugging-port=${port}`,
    // Pin the UI language so labels do not follow the runner's locale.
    `--lang=${lang}`,
    '--host-resolver-rules=MAP * 0.0.0.0,EXCLUDE localhost,EXCLUDE 127.0.0.1',
    '--proxy-server=http://127.0.0.1:9',
  ], {
    cwd: path.dirname(appExe),
    env: {
      ...process.env,
      ALL_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      HTTP_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: 'localhost,127.0.0.1',
      CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE: '1',
      CODEX_ELECTRON_USER_DATA_PATH: userData,
      CODEX_HOME: codexHome,
    },
    stdio: ['ignore', out, err],
    windowsHide: false,
  });
  try {
    return await readVisibleSections(port, Date.now() + timeoutMs);
  } finally {
    killProcessTree(child.pid);
    fs.closeSync(out);
    fs.closeSync(err);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      'portable-root': { type: 'string' },
      'out-dir': { type: 'string' },
      'work-root': { type: 'string' },
      version: { type: 'string' },
      'timeout-ms': { type: 'string' },
      expectations: { type: 'string' },
      lang: { type: 'string' },
      baseline: { type: 'string' },
      promote: { type: 'string' },
    },
  });
  if (values.promote) {
    promote(path.resolve(values.promote));
    return;
  }
  if (process.platform !== 'win32') throw new Error('offline feature probe is Windows-only.');
  if (!values['portable-root'] || !values['out-dir']) throw new Error('--portable-root and --out-dir are required');
  const appRoot = path.join(path.resolve(values['portable-root']), '_internal', 'app');
  const appExe = path.join(appRoot, MAIN_EXECUTABLE_NAME);
  if (!fs.existsSync(appExe)) throw new Error(`${MAIN_EXECUTABLE_NAME} was not found: ${appExe}`);
  const expectations = JSON.parse(fs.readFileSync(
    values.expectations ?? path.join(scriptDir, 'offline-feature-expectations.json'), 'utf8'));
  const workRoot = path.resolve(values['work-root'] ??
    path.join(os.tmpdir(), `codex-offline-feature-probe-${Date.now()}`));
  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.mkdirSync(workRoot, { recursive: true });

  const staticGroups = extractSettingsNavigation(readAsarJs(path.join(appRoot, 'resources', 'app.asar')));
  // A launch that never settles or fails the structural checks is retried once
  // from a fresh profile; contradicting a UI-confirmed expectation is not.
  let visible = [];
  let checks = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const attemptRoot = path.join(workRoot, `attempt-${attempt}`);
    try {
      visible = await launchAndRead({
        appExe,
        workRoot: attemptRoot,
        timeoutMs: Number(values['timeout-ms'] ?? 90_000),
        lang: values.lang ?? 'zh-CN',
      });
      checks = checkProbe({ staticGroups, visible, expectations });
    } catch (error) {
      checks = { problems: [error.message], contradictions: [], warnings: [] };
    }
    if (checks.problems.length === 0) break;
    console.warn(`[offline-feature-probe] attempt ${attempt} failed: ${checks.problems.join('; ')}`);
  }
  const { problems, contradictions, warnings } = checks;
  const report = buildFeatureReport({ staticGroups, visible, expectations, version: values.version });
  const baselinePath = path.resolve(values.baseline ?? BASELINE_PATH);
  const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : null;
  const diff = diffFeatures(baseline, report);
  const outDir = path.resolve(values['out-dir']);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'offline-features.json'),
    JSON.stringify({ ...report, diff, problems, contradictions, warnings }, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'offline-features.md'), renderFeatureMarkdown(report, diff));
  // Only a run that passed every check may speak in release notes.
  const releasePath = path.join(outDir, 'offline-features-release.md');
  fs.rmSync(releasePath, { force: true });
  if (problems.length === 0 && contradictions.length === 0) {
    const repository = process.env.GITHUB_REPOSITORY || 'lusipad/unofficial-codex-app-offline';
    fs.writeFileSync(releasePath,
      renderReleaseSnippet(diff, `https://github.com/${repository}/blob/main/docs/offline-features.md`));
  }

  const sections = report.groups.flatMap((group) => group.sections);
  console.log(`[offline-feature-probe] ${sections.filter((s) => s.visible).length}/${sections.length} ` +
    `settings sections visible (${report.mode}).`);
  for (const message of warnings) console.warn(`[offline-feature-probe] warning: ${message}`);
  for (const message of [...problems, ...contradictions]) console.error(`[offline-feature-probe] ${message}`);
  if (problems.length > 0 || contradictions.length > 0) process.exit(1);
}

// Turns a reviewed probe report into the committed baseline and user document.
function promote(reportPath) {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  if (report.problems?.length || report.contradictions?.length) {
    throw new Error(`refusing to promote a report that failed its checks: ${reportPath}`);
  }
  if (report.groups.some((group) => group.sections.some((s) => !s.visible && !s.reason))) {
    throw new Error('refusing to promote: every hidden section needs a note in offline-feature-expectations.json');
  }
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(toFeatureBaseline(report), null, 2) + '\n');
  fs.writeFileSync(USER_DOC_PATH, renderUserDocument(report));
  console.log(`[offline-feature-probe] promoted ${report.version} to ` +
    `${path.relative(repoRoot, BASELINE_PATH)} and ${path.relative(repoRoot, USER_DOC_PATH)}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[offline-feature-probe] ${error.message}`);
    process.exit(1);
  });
}
