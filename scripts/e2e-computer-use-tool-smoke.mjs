import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const args = parseArgs(process.argv.slice(2));

const appRoot = resolveAppRoot(args.appRoot ?? process.env.CODEX_E2E_APP_ROOT ?? '');
const workRoot = path.resolve(args.workRoot ?? path.join(process.env.TEMP ?? process.cwd(), 'codex-offline-computer-use-e2e'));
const markerSuffix = args.markerSuffix ?? String(Date.now());
const marker = args.marker ?? `E2E_COMPUTER_USE_MARKER_${markerSuffix}`;
const timeoutMs = Number(args.timeoutMs ?? 420_000);
const debugPort = Number(args.debugPort ?? 9387);
const codexHome = args.codexHome ? path.resolve(args.codexHome) : process.env.CODEX_HOME;

if (!appRoot || !fs.existsSync(path.join(appRoot, 'Codex.exe'))) {
  throw new Error(`Codex.exe was not found under app root: ${appRoot}`);
}

fs.rmSync(workRoot, { force: true, recursive: true });
fs.mkdirSync(workRoot, { recursive: true });

const stdoutPath = path.join(workRoot, 'codex-stdout.log');
const stderrPath = path.join(workRoot, 'codex-stderr.log');
const resultPath = path.join(workRoot, 'result.json');
const finalBodyPath = path.join(workRoot, 'final-body.txt');
const progressPath = path.join(workRoot, 'progress.json');
const composerDiagnosticsPath = path.join(workRoot, 'composer-diagnostics.json');
const userDataPath = path.join(workRoot, 'user-data');

const out = fs.openSync(stdoutPath, 'w');
const err = fs.openSync(stderrPath, 'w');
const appProcess = spawn(path.join(appRoot, 'Codex.exe'), [
  `--user-data-dir=${userDataPath}`,
  `--remote-debugging-port=${debugPort}`,
], {
  cwd: appRoot,
  detached: false,
  env: {
    ...process.env,
    ...(codexHome ? { CODEX_HOME: codexHome } : {}),
    CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE: '1',
    CODEX_ELECTRON_USER_DATA_PATH: userDataPath,
  },
  stdio: ['ignore', out, err],
  windowsHide: false,
});

let pass = false;
let reason = 'not-run';
let finalBody = '';
let browser = null;
let codexWindow = null;

try {
  browser = await connectToElectronOverCdp(debugPort, 120_000);
  codexWindow = await findCodexWindow(browser, 120_000);
  await codexWindow.waitForLoadState('domcontentloaded', { timeout: 120_000 }).catch(() => {});
  await codexWindow.waitForTimeout(8_000);
  await codexWindow.setViewportSize({ width: 1450, height: 900 });

  await clickNewChat(codexWindow);
  await enterComputerPrompt(codexWindow, buildPrompt({ marker }), {
    composerDiagnosticsPath,
  });
  await pollForAnswer(codexWindow, {
    marker,
    progressPath,
    timeoutMs,
  });

  finalBody = await codexWindow.locator('body').innerText({ timeout: 10_000 });
  fs.writeFileSync(finalBodyPath, finalBody, 'utf8');
  const finalAnswer = extractAnswerAfterMarker(finalBody, marker);
  const stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : '';
  const summary = extractListAppsSummary(finalAnswer);
  const bridgeEvidence = inspectBridgeEvidence(stdout);
  pass = finalAnswer.includes(marker) &&
    /COMPUTER_USE_TOOL_AVAILABLE/i.test(finalAnswer) &&
    summary != null &&
    summary.isArray === true &&
    Number.isInteger(summary.count) &&
    summary.count > 0 &&
    Array.isArray(summary.sample) &&
    summary.sample.length > 0 &&
    bridgeEvidence.hasNodeReplListAppsCall &&
    bridgeEvidence.hasSummaryOutput &&
    !bridgeEvidence.hasSshTarget &&
    !bridgeEvidence.hasBlockingBridgeError;
  reason = pass
    ? 'computer-use-list-apps-summary-confirmed'
    : bridgeEvidence.hasSshTarget
      ? 'computer-use-js-returned-ssh-target'
      : bridgeEvidence.hasBlockingBridgeError
        ? 'computer-use-js-bridge-reported-error'
        : summary == null
          ? 'final-answer-missing-list-apps-summary'
          : !bridgeEvidence.hasSummaryOutput
            ? 'bridge-missing-list-apps-summary-output'
            : 'list-apps-summary-did-not-confirm-apps';
} catch (error) {
  reason = error instanceof Error ? error.message : String(error);
  try {
    const window = codexWindow ?? (browser ? await findCodexWindow(browser, 5_000).catch(() => null) : null);
    if (window) {
      finalBody = await window.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
      fs.writeFileSync(finalBodyPath, finalBody, 'utf8');
    }
  } catch {
    // Best-effort diagnostic only.
  }
} finally {
  const result = {
    pass,
    reason,
    marker,
    markerSuffix,
    workRoot,
    stdoutPath,
    stderrPath,
    finalBodyPath,
    progressPath,
    composerDiagnosticsPath,
    userDataPath,
    codexHome,
  };
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
  killProcessTree(appProcess.pid);
  await closeWithTimeout(browser?.close().catch(() => {}), 5_000);
  fs.closeSync(out);
  fs.closeSync(err);
}

console.log(JSON.stringify(JSON.parse(fs.readFileSync(resultPath, 'utf8')), null, 2));
process.exit(pass ? 0 : 1);

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
    parsed[key] = value;
  }
  return parsed;
}

function resolveAppRoot(input) {
  const root = path.resolve(input ?? '');
  if (fs.existsSync(path.join(root, 'Codex.exe'))) return root;

  const packagedAppRoot = path.join(root, '_internal', 'app');
  if (fs.existsSync(path.join(packagedAppRoot, 'Codex.exe'))) return packagedAppRoot;

  return root;
}

async function connectToElectronOverCdp(port, timeoutMs) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5_000 });
    } catch (error) {
      lastError = error;
      await delay(1_000);
    }
  }
  throw new Error(`Timed out connecting to Codex CDP port ${port}: ${lastError?.message ?? lastError}`);
}

async function findCodexWindow(browser, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        try {
          const url = page.url();
          if (url.startsWith('devtools://')) continue;
          await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
          const body = await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '');
          if (body.includes('新对话') || body.includes('New chat') || body.includes('Codex')) {
            return page;
          }
        } catch {
          // Keep polling while the app starts.
        }
      }
    }
    await delay(1_000);
  }
  throw new Error('Timed out waiting for the Codex app window over CDP.');
}

async function clickNewChat(window) {
  const buttons = [
    window.getByText('新对话').first(),
    window.getByRole('button', { name: /新对话|New chat/i }).first(),
  ];
  for (const button of buttons) {
    try {
      await button.click({ timeout: 8_000 });
      await window.waitForTimeout(1_500);
      return;
    } catch {
      // Try the next selector.
    }
  }
}

async function enterComputerPrompt(window, prompt, { composerDiagnosticsPath }) {
  const composer = await findComposer(window);
  await composer.click();
  await window.keyboard.type('@电脑', { delay: 1 });
  await window.waitForTimeout(1_500);
  await chooseComputerMention(window);
  await window.waitForTimeout(750);
  const composerDiagnostics = await captureComposerDiagnostics(composer);
  fs.writeFileSync(composerDiagnosticsPath, JSON.stringify(composerDiagnostics, null, 2), 'utf8');
  if (!composerDiagnostics.hasStructuredComputerUseMention) {
    throw new Error(`computer-use-plugin-mention-not-structured: ${composerDiagnostics.summary}`);
  }
  await window.keyboard.type(` ${prompt}`, { delay: 1 });
  await window.keyboard.press('Enter');
}

async function findComposer(window) {
  const candidates = [
    window.locator('[contenteditable="true"]').last(),
    window.getByRole('textbox').last(),
    window.locator('textarea').last(),
  ];
  for (const candidate of candidates) {
    try {
      await candidate.waitFor({ state: 'visible', timeout: 10_000 });
      return candidate;
    } catch {
      // Try the next selector.
    }
  }
  throw new Error('Composer was not found.');
}

async function chooseComputerMention(window) {
  const candidates = [
    window.getByText(/^电脑$/).last(),
    window.getByText(/^Computer$/i).last(),
    window.getByText(/^Computer Use$/).last(),
    window.getByText(/Control Windows apps from Codex/i).last(),
  ];
  for (const candidate of candidates) {
    try {
      await candidate.click({ timeout: 5_000 });
      await window.waitForTimeout(500);
      return;
    } catch {
      // Try the next selector.
    }
  }
  await window.keyboard.press('Enter');
  await window.waitForTimeout(500);
}

async function captureComposerDiagnostics(composer) {
  return composer.evaluate((element) => {
    const root = element instanceof Element
      ? (element.closest('[contenteditable="true"]') ?? element)
      : element;
    const text = element instanceof HTMLElement
      ? (element.innerText ?? element.textContent ?? '')
      : '';
    const pluginMentions = root instanceof Element
      ? Array.from(root.querySelectorAll('[plugin-mention-path]')).map((node) => ({
          path: node.getAttribute('plugin-mention-path') ?? '',
          name: node.getAttribute('plugin-mention-name') ?? '',
          displayName: node.getAttribute('plugin-mention-display-name') ?? '',
          text: node.textContent ?? '',
        }))
      : [];
    const hasStructuredComputerUseMention = pluginMentions.some((mention) => (
      mention.path === 'plugin://computer-use' ||
      mention.path.startsWith('plugin://computer-use@') ||
      mention.name === 'computer-use'
    ));
    return {
      text,
      pluginMentions,
      hasStructuredComputerUseMention,
      summary: pluginMentions.length === 0
        ? `text=${JSON.stringify(text)} mentions=[]`
        : `text=${JSON.stringify(text)} mentions=${JSON.stringify(pluginMentions)}`,
    };
  });
}

function buildPrompt({ marker }) {
  const markerSuffix = marker.replace(/^E2E_COMPUTER_USE_MARKER_/, '');
  return [
    '这是 Computer Use 工具暴露验收，只做无副作用检查。',
    '请使用 Computer Use 插件说明里的官方 JavaScript 入口，不要使用 shell、PowerShell、SendKeys、外部 Playwright/CDP 或其他 Windows 自动化替代路径。',
    '先连接 Windows，再执行轻量检查 list_apps。',
    '不要因为 globalThis.sky 初始不存在就判定缺入口；必须先通过插件根目录的 scripts/computer-use-client.mjs 导入 setupComputerUseRuntime 并执行 await setupComputerUseRuntime({ globals: globalThis })。',
    '插件根目录可由 process.env.NODE_REPL_NODE_MODULE_DIRS 的父目录推导；如果该环境变量缺失，再按 Computer Use 技能说明查找插件根目录。',
    '请在官方 JavaScript 入口里计算一个摘要：const apps = await sky.list_apps(); const summary = { isArray: Array.isArray(apps), count: Array.isArray(apps) ? apps.length : -1, sample: Array.isArray(apps) ? apps.slice(0, 3).map(app => ({ id: String(app?.id ?? ""), displayName: String(app?.displayName ?? ""), windowCount: Array.isArray(app?.windows) ? app.windows.length : 0, isRunning: app?.isRunning === true })) : [] };',
    '请用 nodeRepl.write("COMPUTER_USE_LIST_APPS_SUMMARY=" + JSON.stringify(summary)) 输出摘要。',
    `最终回答必须包含一个 marker：把 E2E_COMPUTER_USE_MARKER 和 ${markerSuffix} 用下划线拼接。`,
    '如果 list_apps 返回了 isArray=true 且 count>0 的非错误结果，再回答把 COMPUTER_USE、TOOL、AVAILABLE 三段用下划线拼接后的短语，并单独回显一行 COMPUTER_USE_LIST_APPS_SUMMARY=<JSON>。',
    '如果当前会话没有 Computer Use 需要的执行入口，回答 marker 后说明缺少官方执行入口。',
    '如果连接到了工具但 helper 或 pipe 失败，回答 marker 后说明 helper 或 pipe 失败并附上一行精确错误。',
  ].join('');
}

async function pollForAnswer(window, { marker, progressPath, timeoutMs }) {
  const start = Date.now();
  let lastBody = '';
  while (Date.now() - start < timeoutMs) {
    lastBody = await window.locator('body').innerText({ timeout: 10_000 }).catch(() => lastBody);
    const answer = extractAnswerAfterMarker(lastBody, marker);
    const tail = answer.slice(-5000);
    const stillThinking = /正在思考|Thinking/i.test(tail);
    const state = {
      elapsedMs: Date.now() - start,
      hasMarker: answer.includes(marker),
      hasToolAvailable: /COMPUTER_USE_TOOL_AVAILABLE/i.test(tail),
      hasListAppsSummary: extractListAppsSummary(tail) != null,
      hasMissingNodeRepl: /COMPUTER_USE_TOOL_MISSING_NODE_REPL|node_repl|Node REPL|JavaScript 执行工具/i.test(tail),
      hasMissingOfficialEntry: /官方执行入口|官方 JavaScript 执行入口|official execution entry|官方工具入口/i.test(tail),
      hasHelperFailed: /COMPUTER_USE_HELPER_FAILED|native pipe|helper|sky|Computer Use native pipe/i.test(tail),
      stillThinking,
      tail,
    };
    fs.writeFileSync(progressPath, JSON.stringify(state, null, 2), 'utf8');
    if (
      state.hasMarker &&
      (
        (state.hasToolAvailable && state.hasListAppsSummary) ||
        (!state.stillThinking && (
          state.hasMissingNodeRepl ||
          state.hasMissingOfficialEntry ||
          state.hasHelperFailed
        ))
      )
    ) return;
    await window.waitForTimeout(5_000);
  }
  throw new Error('Timed out waiting for Codex UI answer to include the Computer Use marker.');
}

function extractAnswerAfterMarker(body, marker) {
  const markerIndex = body.lastIndexOf(marker);
  if (markerIndex === -1) return '';
  return body.slice(markerIndex);
}

function extractListAppsSummary(text) {
  const match = text.match(/COMPUTER_USE_LIST_APPS_SUMMARY=({[^\r\n]+})/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function inspectBridgeEvidence(stdout) {
  const bridgeLines = stdout
    .split(/\r?\n/)
    .filter(line => line.includes('computer_use_node_repl_js_call'));
  return {
    hasNodeReplListAppsCall: bridgeLines.some(line => (
      line.includes('hasListApps=true') &&
      line.includes('isError=false')
    )),
    hasSummaryOutput: bridgeLines.some(line => (
      line.includes('COMPUTER_USE_LIST_APPS_SUMMARY=') &&
      /\\?"isArray\\?":true/.test(line)
    )),
    hasSshTarget: bridgeLines.some(line => line.includes('resultPrefix={"kind":"ssh"')),
    hasBlockingBridgeError:
      bridgeLines.some(line => line.includes('isError=true')) &&
      !bridgeLines.some(line => (
        line.includes('COMPUTER_USE_LIST_APPS_SUMMARY=') &&
        /\\?"isArray\\?":true/.test(line)
      )),
  };
}

function killProcessTree(pid) {
  if (!pid) return;
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // Process may already be gone.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeWithTimeout(promise, timeoutMs) {
  if (!promise) return;
  await Promise.race([
    promise,
    delay(timeoutMs),
  ]);
}
