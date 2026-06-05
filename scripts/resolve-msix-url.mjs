#!/usr/bin/env node
// resolve-msix-url.mjs — Get MSIX CDN URL via Playwright browser
import { chromium } from 'playwright';

async function resolveMsixUrl(version) {
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36',
    });
    const page = await ctx.newPage();

    // Block ad/tracking requests
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (/doubleclick|googlesyndication|googleads|google-analytics/i.test(url)) {
        await route.abort();
      } else {
        await route.continue();
      }
    });

    await page.goto('https://store.rg-adguard.net/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000);
    console.log('Page:', await page.title());

    // Fill form using the correct selectors (from resolve-store-bundle-url.mjs)
    console.log('Filling form...');
    await page.selectOption('#type', 'PackageFamilyName');
    await page.fill('#url', 'OpenAI.Codex_2p2nqsd0c76g0');
    await page.selectOption('#ring', 'Retail');

    // Click the ✔ button AND wait for API response simultaneously
    console.log('Clicking submit and waiting for API...');
    try {
      await Promise.all([
        page.waitForResponse(
          (response) => response.url().includes('/api/GetFiles') && response.status() === 200,
          { timeout: 30000 }
        ),
        page.locator('input[type="button"][value="✔"]').click(),
      ]);
      console.log('API response received');
    } catch (err) {
      console.log('API wait error:', err.message);
    }

    await page.waitForTimeout(3000);

    // Extract links using same approach as resolve-store-bundle-url.mjs
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
        .filter((entry) => entry.fileName.includes(filter.packageName) &&
          (entry.fileName.endsWith('.msix') || entry.fileName.endsWith('.msixbundle')));
    }, {
      packageName: 'OpenAI.Codex',
    });

    const msix = links.filter(l =>
      l.fileName && l.fileName.includes('OpenAI.Codex') &&
      (l.fileName.endsWith('.msix') || l.fileName.includes('.msixbundle'))
    );

    console.log(`Found ${msix.length} MSIX links:`);
    msix.forEach(l => console.log(`  ${l.fileName} (${l.size || 'unknown size'})`));

    if (version) {
      const target = msix.find(l => l.fileName.includes(version));
      if (target) {
        console.log(`\n=== TARGET MSIX URL ===`);
        console.log(target.href);
        console.log(`File: ${target.fileName}`);
        console.log(`Size: ${target.size}`);
        console.log(`SHA1: ${target.sha1}`);
        return target.href;
      }
    }
    if (msix.length > 0) {
      console.log('\n=== LATEST MSIX ===');
      console.log('URL:', msix[0].href);
      console.log('File:', msix[0].fileName);
      console.log('Size:', msix[0].size);
    }
    return msix.length > 0 ? msix[0].href : null;
  } finally {
    await browser.close();
  }
}

const version = process.argv[2] || null;
const url = await resolveMsixUrl(version);
if (url) {
  process.exit(0);
} else {
  console.error('No MSIX URL found');
  process.exit(1);
}
