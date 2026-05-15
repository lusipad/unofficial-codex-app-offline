import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const args = parseArgs(process.argv.slice(2));

const appRoot = path.resolve(args.appRoot ?? process.env.CODEX_E2E_APP_ROOT ?? '');
const chromePath = path.resolve(args.chromePath ?? findChromePath() ?? '');
const extensionRoot = path.resolve(args.extensionRoot ?? process.env.CODEX_E2E_EXTENSION_ROOT ?? '');
const workRoot = path.resolve(args.workRoot ?? path.join(process.env.TEMP ?? process.cwd(), 'codex-offline-chrome-e2e-v2'));
const marker = args.marker ?? `E2E_CHROME_HISTORY_MARKER_${Date.now()}`;
const title = args.title ?? `Codex App Recent History - Chrome E2E ${marker}`;
const chromeMode = args.chromeMode ?? 'installed';

if (!appRoot || !fs.existsSync(path.join(appRoot, 'Codex.exe'))) {
  throw new Error(`Codex.exe was not found under app root: ${appRoot}`);
}
if (!chromePath || !fs.existsSync(chromePath)) {
  throw new Error(`Chrome was not found: ${chromePath}`);
}
if (chromeMode === 'load-extension' && (!extensionRoot || !fs.existsSync(path.join(extensionRoot, 'manifest.json')))) {
  throw new Error(`Chrome extension manifest was not found under: ${extensionRoot}`);
}
if (!['installed', 'load-extension'].includes(chromeMode)) {
  throw new Error(`Unsupported Chrome mode: ${chromeMode}`);
}

fs.rmSync(workRoot, { force: true, recursive: true });
fs.mkdirSync(workRoot, { recursive: true });

const chromeProfile = path.join(workRoot, 'chrome-profile');
const htmlPath = path.join(workRoot, 'codex-history-e2e.html');
const stdoutPath = path.join(workRoot, 'codex-stdout.log');
const stderrPath = path.join(workRoot, 'codex-stderr.log');
const resultPath = path.join(workRoot, 'result.json');
const finalBodyPath = path.join(workRoot, 'final-body.txt');
const progressPath = path.join(workRoot, 'progress.json');

fs.writeFileSync(htmlPath, renderHtml({ marker, title }), 'utf8');
registerNativeHost(appRoot);

const targetServer = await startTargetServer({ htmlPath });
const targetUrl = targetServer.url;
const debugPort = Number(args.debugPort ?? 9377);
const out = fs.openSync(stdoutPath, 'w');
const err = fs.openSync(stderrPath, 'w');
const appProcess = spawn(path.join(appRoot, 'Codex.exe'), [`--remote-debugging-port=${debugPort}`], {
  cwd: appRoot,
  detached: false,
  env: {
    ...process.env,
    CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE: '1',
  },
  stdio: ['ignore', out, err],
  windowsHide: false,
});

let pass = false;
let reason = 'not-run';
let finalBody = '';
let chromeProbe = null;
let browser = null;
let chromeHandle = {
  close: async () => {},
};
let codexWindow = null;

try {
  chromeHandle = await openChromeTarget({
    chromeMode,
    chromePath,
    chromeProfile,
    extensionRoot,
    targetUrl,
  });
  chromeProbe = await waitForChromeBrowserUsePipe({
    timeoutMs: Number(args.chromeProbeTimeoutMs ?? 120_000),
    targetUrl,
    title,
  });
  browser = await connectToElectronOverCdp(debugPort, 120_000);
  codexWindow = await findCodexWindow(browser, 120_000);
  await codexWindow.waitForLoadState('domcontentloaded', { timeout: 120_000 }).catch(() => {});
  await codexWindow.waitForTimeout(8_000);
  await codexWindow.setViewportSize({ width: 1450, height: 900 });

  await clickNewChat(codexWindow);
  const prompt = buildPrompt({ title });
  await enterChromePrompt(codexWindow, prompt);
  await pollForAnswer(codexWindow, {
    marker,
    progressPath,
    timeoutMs: Number(args.timeoutMs ?? 600_000),
  });

  finalBody = await codexWindow.locator('body').innerText({ timeout: 10_000 });
  fs.writeFileSync(finalBodyPath, finalBody, 'utf8');
  pass = finalBody.includes(marker) &&
    /codex-app-offline/i.test(finalBody) &&
    /OpenDeepWiki/i.test(finalBody) &&
    /RocketBot/i.test(finalBody);
  reason = pass ? 'marker-and-summary-present' : 'final-answer-missing-marker-or-summary';
} catch (error) {
  reason = error instanceof Error ? error.message : String(error);
  try {
    const window = codexWindow ?? (browser ? await findCodexWindow(browser, 5_000).catch(() => null) : null);
    if (window) {
      finalBody = await window.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
      fs.writeFileSync(finalBodyPath, finalBody, 'utf8');
    }
  } catch {
    // best effort diagnostic only
  }
} finally {
  const result = {
    pass,
    reason,
    marker,
    title,
    workRoot,
    stdoutPath,
    stderrPath,
    finalBodyPath,
    chromeProfile,
    chromeMode,
    chromeProbe,
    htmlPath,
  };
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
  killProcessTree(appProcess.pid);
  await closeWithTimeout(browser?.close().catch(() => {}), 5_000);
  await closeWithTimeout(chromeHandle.close(), 5_000);
  await targetServer.close();
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

function findChromePath() {
  const candidates = [
    path.join(process.env.ProgramFiles ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

function startTargetServer({ htmlPath }) {
  const html = fs.readFileSync(htmlPath);
  const server = http.createServer((request, response) => {
    if (request.url === '/' || request.url === '/codex-history-e2e.html') {
      response.writeHead(200, {
        'content-length': html.byteLength,
        'content-type': 'text/html; charset=utf-8',
      });
      response.end(html);
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to bind target HTTP server.'));
        return;
      }

      resolve({
        url: `http://127.0.0.1:${address.port}/codex-history-e2e.html`,
        close: () => new Promise((closeResolve) => server.close(() => closeResolve())),
      });
    });
  });
}

function registerNativeHost(root) {
  const script = path.resolve('scripts', 'repair-chrome-host.ps1');
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-InstallRoot',
    root,
  ], { stdio: 'pipe' });
}

async function openChromeTarget({ chromeMode, chromePath, chromeProfile, extensionRoot, targetUrl }) {
  if (chromeMode === 'load-extension') {
    const chromeContext = await chromium.launchPersistentContext(chromeProfile, {
      executablePath: chromePath,
      headless: false,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        `--disable-extensions-except=${extensionRoot}`,
        `--load-extension=${extensionRoot}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    await assertChromeExtensionLoaded({
      chromeContext,
      chromePath,
      extensionRoot,
    });
    const chromePage = await chromeContext.newPage();
    await chromePage.goto(targetUrl);
    await chromePage.waitForLoadState('domcontentloaded');
    return {
      close: async () => {
        await chromeContext.close().catch(() => {});
      },
    };
  }

  const chromeProcess = spawn(chromePath, [targetUrl], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  chromeProcess.unref();
  await delay(5_000);
  return {
    close: async () => {
      // This mode intentionally uses the user's installed Chrome profile and
      // must not close Chrome or the user's existing windows.
    },
  };
}

async function assertChromeExtensionLoaded({ chromeContext, chromePath, extensionRoot }) {
  const expectedExtensionId = readExpectedChromeExtensionId(extensionRoot);
  if (!expectedExtensionId) {
    return;
  }

  const extensionOrigin = `chrome-extension://${expectedExtensionId}/`;
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    const hasServiceWorker = chromeContext
      .serviceWorkers()
      .some((worker) => worker.url().startsWith(extensionOrigin));
    if (hasServiceWorker) {
      return;
    }
    await delay(250);
  }

  let popupProbeError = null;
  const popupProbePage = await chromeContext.newPage();
  try {
    await popupProbePage.goto(`${extensionOrigin}popup.html`, {
      timeout: 5_000,
      waitUntil: 'domcontentloaded',
    });
    return;
  } catch (error) {
    popupProbeError = error instanceof Error ? error.message : String(error);
  } finally {
    await popupProbePage.close().catch(() => {});
  }

  const chromeHint = isLikelyGoogleChrome(chromePath)
    ? ' Stock Google Chrome blocks the command-line unpacked-extension loading path used by this smoke (`--disable-extensions-except` is ignored), so use `--chromeMode installed` after manually loading `_internal\\\\chrome-extension\\\\unpacked` in `chrome://extensions`, or run this smoke against a Chromium build that permits command-line extension loading.'
    : '';
  throw new Error(
    `Chrome did not load the unpacked Codex extension (expected extension id ${expectedExtensionId}).` +
      chromeHint +
      (popupProbeError ? ` Popup probe: ${popupProbeError}` : ''),
  );
}

function readExpectedChromeExtensionId(extensionRoot) {
  const extensionInfoPath = path.resolve(extensionRoot, '..', 'extension-info.json');
  if (fs.existsSync(extensionInfoPath)) {
    try {
      const extensionInfo = JSON.parse(fs.readFileSync(extensionInfoPath, 'utf8'));
      if (typeof extensionInfo?.extensionId === 'string' && extensionInfo.extensionId) {
        return extensionInfo.extensionId;
      }
    } catch {
      // Fall back to deriving the id from manifest.key.
    }
  }

  const manifestPath = path.join(extensionRoot, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (typeof manifest?.key !== 'string' || !manifest.key) {
      return null;
    }
    return extensionIdFromPublicKey(Buffer.from(manifest.key, 'base64'));
  } catch {
    return null;
  }
}

function extensionIdFromPublicKey(publicKey) {
  const hash = createHash('sha256').update(publicKey).digest().subarray(0, 16);
  return Array.from(hash, (byte) =>
    String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 0x0f)),
  ).join('');
}

function isLikelyGoogleChrome(chromePath) {
  return /Google[\\/]+Chrome[\\/]+Application[\\/]+chrome\.exe$/i.test(chromePath);
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

async function enterChromePrompt(window, prompt) {
  const composer = await findComposer(window);
  await composer.click();
  await composer.fill('@chrome');
  await window.waitForTimeout(1_500);
  await chooseChromeMention(window);
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

async function chooseChromeMention(window) {
  const candidates = [
    window.getByText(/^Chrome$/).last(),
    window.getByText(/Control Chrome with Codex/).last(),
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

async function pollForAnswer(window, { marker, progressPath, timeoutMs }) {
  const start = Date.now();
  let lastBody = '';
  while (Date.now() - start < timeoutMs) {
    lastBody = await window.locator('body').innerText({ timeout: 10_000 }).catch(() => lastBody);
    const tail = lastBody.slice(-5000);
    const state = {
      elapsedMs: Date.now() - start,
      hasMarker: lastBody.includes(marker),
      hasTrustedError: /^privileged native pipe bridge is not available|^browser-client is not trusted/im.test(tail),
      hasUnavailable: /Cannot communicate with the Codex Chrome Extension|无法和 Chrome 通信|Failed to connect to browser "extension"/i.test(tail),
      tail,
    };
    fs.writeFileSync(progressPath, JSON.stringify(state, null, 2), 'utf8');
    if (state.hasMarker) return;
    if (state.hasTrustedError) throw new Error('Trusted browser-client error surfaced in UI.');
    await window.waitForTimeout(5_000);
  }
  throw new Error('Timed out waiting for Codex UI answer to include the Chrome-only marker.');
}

function buildPrompt({ title }) {
  return [
    '这是 @chrome 端到端验收。请使用 Chrome 插件 API；目标网页内容只能通过 Chrome 插件读取，不要使用 shell、剪贴板、外部 Playwright/CDP 或读取本地 HTML 文件。',
    '不要运行任何命令行诊断。只使用 node_repl 执行 JavaScript；如果连接失败，重新执行 setupAtlasRuntime 后等待 2 秒再试，最多重试 8 次。',
    '按 Chrome skill 的 bootstrap 流程连接 Chrome：用 process.env.CODEX_HOME 或 node:os 的 os.homedir()，不要用 nodeRepl.homeDir；优先从 <home>/.codex/.tmp/bundled-marketplaces/openai-bundled/plugins/chrome 加载 scripts/browser-client.mjs，执行 setupAtlasRuntime({ globals: globalThis })，再调用 globalThis.agent.browsers.get("extension")。',
    '不要调用 browser.nameSession；直接用 browser.user.openTabs() 查找目标标签页。',
    `在已打开的 Chrome 标签页中找到标题为“${title}”的页面。`,
    '调用 browser.user.openTabs()，claim 目标标签页，再用 tab.playwright 或页面文本能力读取正文。',
    '最后用中文回答：页面中的 E2E marker 是什么；最近任务集中在哪些项目和主题上。',
    '不要复述你的工具代码，只给结论。',
  ].join('');
}

function renderHtml({ marker, title }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><main><h1>Codex App 最近历史记录</h1><p id="marker">E2E marker: ${escapeHtml(marker)}</p><section><h2>最近项目</h2><ul><li>codex-app-offline: 处理 GitHub issues，重点是离线包、Chrome 插件、native host、@chrome 端到端验证。</li><li>OpenDeepWiki: Rust CLI Windows 发布 smoke、local/claude-code translate 到 export-site 闭环。</li><li>aicnc: G-code Viewer 需求评估和 CIMCO 类 browser-local 工作流。</li><li>RocketBot: 将 agent 改造成通用能力，保持真实 Rocket.Chat 联调。</li><li>TaiJianKiller: 整理后台工作台和作者复活验证资料分层。</li></ul></section><section><h2>主题归纳</h2><p>最近任务集中在离线打包、真实端到端验证、CLI-first 收敛、浏览器本地能力、以及多项目工程化交付。</p></section></main></body></html>`;
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function waitForChromeBrowserUsePipe({ timeoutMs, targetUrl, title }) {
  const started = Date.now();
  let attempts = 0;
  let lastErrors = [];

  while (Date.now() - started < timeoutMs) {
    attempts += 1;
    const pipePaths = listBrowserUsePipePaths();
    const errors = [];

    for (const pipePath of pipePaths) {
      try {
        const probe = await probeBrowserUsePipe(pipePath, {
          targetUrl,
          title,
          timeoutMs: 6_000,
        });
        if (probe.info?.type === 'extension' && probe.hasTargetTab) {
          return {
            attempts,
            pipePath,
            pipeCount: pipePaths.length,
            browserName: probe.info.name,
            browserType: probe.info.type,
            extensionId: probe.info.metadata?.extensionId,
            targetTabTitle: probe.targetTab?.title,
            targetTabUrl: probe.targetTab?.url,
          };
        }
        const type = probe.info?.type ?? 'unknown';
        const tabCount = probe.tabs?.length ?? 0;
        const tabSummary = (probe.tabs ?? [])
          .slice(0, 4)
          .map((tab) => {
            const tabTitle = typeof tab?.title === 'string' ? tab.title : '';
            const tabUrl = typeof tab?.url === 'string' ? tab.url : '';
            return `${tabTitle || '<untitled>'} <${tabUrl || 'about:blank'}>`;
          })
          .join(' | ');
        errors.push(
          `${pipePath}: ${type}, target missing, tabs=${tabCount}${tabSummary ? `, seen=${tabSummary}` : ''}`,
        );
      } catch (error) {
        errors.push(`${pipePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    lastErrors = errors.slice(-6);
    await delay(1_500);
  }

  throw new Error(
    'Timed out waiting for the Chrome extension Browser Use pipe that can see the target tab. ' +
      `Last errors: ${lastErrors.join('; ')}`,
  );
}

function listBrowserUsePipePaths() {
  const pipeRoot = '\\\\.\\pipe\\';
  try {
    return fs
      .readdirSync(pipeRoot)
      .filter((entry) => entry.startsWith('codex-browser-use'))
      .map((entry) => `${pipeRoot}${entry}`);
  } catch {
    return [];
  }
}

function probeBrowserUsePipe(pipePath, { targetUrl, title, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    const chunks = [];
    let readBuffer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    let info = null;
    let tabs = null;

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    }

    socket.on('connect', () => {
      socket.write(frameNativePipeMessage({
        jsonrpc: '2.0',
        id: 1,
        method: 'getInfo',
        params: {
          session_id: 'codex-offline-chrome-e2e-probe',
          turn_id: 'codex-offline-chrome-e2e-probe',
        },
      }));
    });
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      readBuffer = Buffer.concat(chunks);

      try {
        while (readBuffer.byteLength >= 4) {
          const messageLength = os.endianness() === 'LE'
            ? readBuffer.readUInt32LE(0)
            : readBuffer.readUInt32BE(0);
          if (readBuffer.byteLength < 4 + messageLength) return;

          const message = JSON.parse(readBuffer.subarray(4, 4 + messageLength).toString('utf8'));
          readBuffer = readBuffer.subarray(4 + messageLength);
          chunks.length = 0;
          if (readBuffer.byteLength > 0) chunks.push(readBuffer);

          if (message.error) {
            finish(new Error(message.error.message ?? JSON.stringify(message.error)));
            return;
          }

          if (message.id === 1) {
            info = message.result;
            if (info?.type !== 'extension') {
              finish(null, { info, tabs: [], hasTargetTab: false, targetTab: null });
              return;
            }

            socket.write(frameNativePipeMessage({
              jsonrpc: '2.0',
              id: 2,
              method: 'getUserTabs',
              params: {
                session_id: 'codex-offline-chrome-e2e-probe',
                turn_id: 'codex-offline-chrome-e2e-probe',
              },
            }));
            continue;
          }

          if (message.id === 2) {
            tabs = Array.isArray(message.result) ? message.result : [];
            const targetTab = tabs.find((tab) => {
              const tabTitle = typeof tab?.title === 'string' ? tab.title : '';
              const tabUrl = typeof tab?.url === 'string' ? tab.url : '';
              return tabUrl === targetUrl || tabTitle === title;
            }) ?? null;
            finish(null, {
              info,
              tabs,
              hasTargetTab: targetTab != null,
              targetTab,
            });
            return;
          }
        }
      } catch (error) {
        finish(error);
      }
    });
    socket.on('error', (error) => finish(error));
    socket.on('close', () => finish(new Error('pipe closed before getInfo response')));
  });
}

function frameNativePipeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  if (os.endianness() === 'LE') {
    header.writeUInt32LE(body.byteLength, 0);
  } else {
    header.writeUInt32BE(body.byteLength, 0);
  }
  return Buffer.concat([header, body]);
}
