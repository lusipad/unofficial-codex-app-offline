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

/**
 * Recursively searches a JSON object for a release-notes-like field.
 * @param {unknown} obj
 * @param {number} depth
 * @returns {string | null}
 */
function searchForReleaseNotes(obj, depth = 0) {
  if (depth > 8 || obj === null || typeof obj !== 'object') {
    return null;
  }

  const releaseNotesKeys = new Set(['releasenotes', 'whatsnew', 'changenotes', 'releasenote']);

  if (!Array.isArray(obj)) {
    for (const [key, value] of Object.entries(obj)) {
      if (releaseNotesKeys.has(key.toLowerCase()) && typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }
  }

  for (const value of Array.isArray(obj) ? obj : Object.values(obj)) {
    if (typeof value === 'object' && value !== null) {
      const result = searchForReleaseNotes(value, depth + 1);
      if (result) {
        return result;
      }
    }
  }

  return null;
}

/**
 * Falls back to DOM scraping: looks for a "What's new" heading and returns the text
 * of the following sibling element.
 * @param {import('playwright').Page} page
 * @returns {Promise<string | null>}
 */
async function extractChangelogFromDom(page) {
  return page.evaluate(() => {
    const headingPattern = /what[\u2019']?s new|release notes|change[-\s]?log/i;
    const headingTags = ['h1', 'h2', 'h3', 'h4', 'strong'];

    for (const tag of headingTags) {
      for (const el of document.querySelectorAll(tag)) {
        if (!headingPattern.test(el.textContent || '')) {
          continue;
        }

        // Try immediate next sibling first, then parent's next sibling
        let candidate = el.nextElementSibling ?? el.parentElement?.nextElementSibling ?? null;

        if (candidate) {
          const text = /** @type {HTMLElement} */ (candidate).innerText?.trim();

          if (text && text.length > 10 && !headingPattern.test(text)) {
            return text;
          }
        }
      }
    }

    return null;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageFamilyName = args['package-family-name'] || process.env.CODEX_PACKAGE_FAMILY_NAME;

  if (!packageFamilyName) {
    throw new Error('Missing --package-family-name');
  }

  const browser = await chromium.launch({ headless: true });
  let releaseNotes = null;

  try {
    const context = await browser.newContext({
      locale: 'en-US',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    const page = await context.newPage();

    // Block ad/tracker requests (same pattern as resolve-store-bundle-url.mjs)
    await page.route('**/*', async (route) => {
      const requestUrl = route.request().url();

      if (/doubleclick|googlesyndication|googleads|google-analytics|yandex|top100|mail\.ru|rambler/i.test(requestUrl)) {
        await route.abort();
        return;
      }

      await route.continue();
    });

    // Intercept JSON API responses that may carry release notes
    page.on('response', async (response) => {
      if (releaseNotes !== null) {
        return;
      }

      if (response.status() !== 200) {
        return;
      }

      const url = response.url();

      if (!url.includes('microsoft.com')) {
        return;
      }

      const contentType = (response.headers()['content-type'] || '').toLowerCase();

      if (!contentType.includes('json')) {
        return;
      }

      try {
        const json = await response.json();
        const found = searchForReleaseNotes(json);

        if (found) {
          releaseNotes = found;
        }
      } catch {
        // Ignore JSON parse errors
      }
    });

    const storeUrl = `https://apps.microsoft.com/detail/${encodeURIComponent(packageFamilyName)}?hl=en-us&gl=US`;
    await page.goto(storeUrl, { waitUntil: 'networkidle', timeout: 120000 });

    // DOM-based fallback if API interception found nothing
    if (releaseNotes === null) {
      releaseNotes = await extractChangelogFromDom(page);
    }
  } finally {
    await browser.close();
  }

  process.stdout.write(`${JSON.stringify({ releaseNotes }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`Warning: Failed to fetch app changelog: ${error instanceof Error ? error.message : String(error)}\n`);
  process.stdout.write(`${JSON.stringify({ releaseNotes: null }, null, 2)}\n`);
  process.exit(0);
});
