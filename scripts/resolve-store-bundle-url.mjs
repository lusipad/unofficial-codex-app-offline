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

  if (!packageFamilyName) {
    throw new Error('Missing --package-family-name');
  }

  const packageName = packageFamilyName.split('_')[0];
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

    await page.goto('https://store.rg-adguard.net/', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.selectOption('#type', 'PackageFamilyName');
    await page.fill('#url', packageFamilyName);
    await page.selectOption('#ring', ring);
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/GetFiles') && response.status() === 200, { timeout: 120000 }),
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
  finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
