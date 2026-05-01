import process from 'node:process';
import { chromium } from 'playwright';

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (!current.startsWith('--')) {
      continue;
    }

    const key = current.slice(2);
    const next = argv[index + 1];

    if (next && !next.startsWith('--')) {
      args[key] = next;
      index += 1;
      continue;
    }

    args[key] = 'true';
  }

  return args;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)));
}

function textFromHtml(value) {
  return decodeHtml(value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function parseLinksFromHtml(html, { filePattern, packageName }) {
  const links = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const cellPattern = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let cellMatch;

    while ((cellMatch = cellPattern.exec(rowMatch[1])) !== null) {
      cells.push(cellMatch[1]);
    }

    const anchorMatch = cells[0]?.match(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchorMatch) {
      continue;
    }

    const entry = {
      fileName: textFromHtml(anchorMatch[3]),
      href: decodeHtml(anchorMatch[2]),
      expiresAt: cells[1] ? textFromHtml(cells[1]) : null,
      sha1: cells[2] ? textFromHtml(cells[2]) : null,
      size: cells[3] ? textFromHtml(cells[3]) : null,
    };

    if (filePattern.test(entry.fileName) && entry.fileName.includes(packageName)) {
      links.push(entry);
    }
  }

  return links;
}

async function postRgAdguardApi({ packageFamilyName, ring, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch('https://store.rg-adguard.net/api/GetFiles', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        referer: 'https://store.rg-adguard.net/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145 Safari/537.36',
      },
      body: new URLSearchParams({
        type: 'PackageFamilyName',
        url: packageFamilyName,
        ring,
        lang: '',
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`rg-adguard API returned HTTP ${response.status}`);
    }

    return await response.text();
  }
  finally {
    clearTimeout(timeout);
  }
}

function scoreCandidate(fileName) {
  let score = 0;

  if (/\.blockmap$/i.test(fileName)) {
    return -10000;
  }

  if (/(_x64_|x64)/i.test(fileName)) {
    score += 400;
  }

  if (/\.msixbundle$/i.test(fileName) || /\.appxbundle$/i.test(fileName)) {
    score += 250;
  }

  if (/\.msix$/i.test(fileName) || /\.appx$/i.test(fileName)) {
    score += 200;
  }

  if (/arm64|_x86_|_arm_/i.test(fileName)) {
    score -= 300;
  }

  if (/language|resource|scale|test|debug|symbol/i.test(fileName)) {
    score -= 500;
  }

  return score;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageFamilyName = args['package-family-name'] || process.env.CODEX_PACKAGE_FAMILY_NAME;
  const ring = args.ring || process.env.CODEX_STORE_RING || 'Retail';
  const filePattern = new RegExp(args['file-pattern'] || '\\.(msix|appx|msixbundle|appxbundle)$', 'i');
  const timeoutMs = Number.parseInt(args.timeout || process.env.CODEX_STORE_RESOLVER_TIMEOUT || '120000', 10);

  if (!packageFamilyName) {
    throw new Error('Missing --package-family-name');
  }

  const packageName = packageFamilyName.split('_')[0];
  let links = [];
  let apiError = null;

  try {
    const html = await postRgAdguardApi({ packageFamilyName, ring, timeoutMs });
    links = parseLinksFromHtml(html, { filePattern, packageName });
  }
  catch (error) {
    apiError = error;
  }

  if (links.length === 0) {
    if (apiError) {
      console.error(`Direct rg-adguard API lookup failed; falling back to browser flow: ${apiError.message}`);
    }

    links = await resolveWithBrowser({ packageFamilyName, ring, filePattern, packageName, timeoutMs });
  }

  if (links.length === 0) {
    throw new Error(`Resolver returned no matching files for ${packageFamilyName}.`);
  }

  const ranked = links
    .map((entry) => ({ ...entry, score: scoreCandidate(entry.fileName) }))
    .sort((left, right) => right.score - left.score || left.fileName.localeCompare(right.fileName));

  const selected = ranked[0];
  const versionMatch = selected.fileName.match(/_(\d+(?:\.\d+)+)_/);

  process.stdout.write(`${JSON.stringify({
    packageFamilyName,
    packageName,
    ring,
    resolvedAt: new Date().toISOString(),
    selected,
    candidates: ranked,
    version: versionMatch ? versionMatch[1] : null,
  }, null, 2)}\n`);
}

async function resolveWithBrowser({ packageFamilyName, ring, filePattern, packageName, timeoutMs }) {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();

    await page.route('**/*', async (route) => {
      const requestUrl = route.request().url();

      if (/doubleclick|googlesyndication|googleads|google-analytics|yandex|top100|mail\.ru|rambler/i.test(requestUrl)) {
        await route.abort();
        return;
      }

      await route.continue();
    });

    await page.goto('https://store.rg-adguard.net/', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.selectOption('#type', 'PackageFamilyName');
    await page.fill('#url', packageFamilyName);
    await page.selectOption('#ring', ring);
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/GetFiles') && response.status() === 200, { timeout: timeoutMs }),
      page.locator('input[type="button"][value="✔"]').click(),
    ]);

    await page.waitForTimeout(1500);

    const links = await page.locator('a').evaluateAll((nodes, filter) => {
      return nodes
        .map((anchor) => {
          const row = anchor.closest('tr');
          const cells = row ? [...row.querySelectorAll('td')].map((cell) => cell.innerText.trim()) : [];
          return {
            fileName: anchor.textContent?.trim() || '',
            href: anchor.href,
            expiresAt: cells[1] || null,
            sha1: cells[2] || null,
            size: cells[3] || null,
          };
        })
        .filter((entry) => filter.fileRegex.test(entry.fileName) && entry.fileName.includes(filter.packageName));
    }, {
      fileRegex: filePattern,
      packageName,
    });

    if (links.length === 0) {
      const bodyText = await page.locator('body').innerText();
      throw new Error(`Resolver returned no matching files for ${packageFamilyName}. Page text: ${bodyText}`);
    }

    return links;
  }
  finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
