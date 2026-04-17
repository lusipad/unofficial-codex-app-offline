import process from 'node:process';
import { chromium } from 'playwright';

const CHANGELOG_URL = 'https://developers.openai.com/codex/changelog';

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

function normalizeVersion(version) {
  if (typeof version !== 'string') {
    return null;
  }

  const segments = version.trim().match(/\d+/g);

  if (!segments || segments.length < 2) {
    return version.trim() || null;
  }

  return `${segments[0]}.${segments[1]}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fullVersion = args.version || process.env.CODEX_APP_VERSION;
  const targetVersion = normalizeVersion(fullVersion);

  if (!targetVersion) {
    throw new Error('Missing --version');
  }

  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({
      locale: 'en-US',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    await page.goto(CHANGELOG_URL, { waitUntil: 'networkidle', timeout: 120000 });

    const changelog = await page.evaluate(({ changeLogUrl, versionLabel }) => {
      function normalizeWhitespace(text) {
        return text
          .replace(/\u00a0/g, ' ')
          .replace(/\r\n?/g, '\n')
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n[ \t]+/g, '\n')
          .replace(/[ \t]{2,}/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }

      function makeAbsoluteUrl(path) {
        try {
          return new URL(path, changeLogUrl).toString();
        } catch {
          return changeLogUrl;
        }
      }

      function serializeList(list, ordered) {
        return [...list.children]
          .filter((node) => node.tagName === 'LI')
          .map((node, index) => {
            const prefix = ordered ? `${index + 1}. ` : '- ';
            const text = normalizeWhitespace(node.innerText || node.textContent || '');
            return text ? `${prefix}${text}` : null;
          })
          .filter(Boolean)
          .join('\n');
      }

      function serializeArticle(article) {
        const blocks = [];

        for (const node of article.children) {
          if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') {
            continue;
          }

          if (node.tagName === 'UL') {
            const list = serializeList(node, false);

            if (list) {
              blocks.push(list);
            }

            continue;
          }

          if (node.tagName === 'OL') {
            const list = serializeList(node, true);

            if (list) {
              blocks.push(list);
            }

            continue;
          }

          if (node.tagName === 'PRE') {
            const text = node.textContent?.trim();

            if (text) {
              blocks.push(`\`\`\`\n${text}\n\`\`\``);
            }

            continue;
          }

          if (node.tagName === 'H4') {
            const text = normalizeWhitespace(node.textContent || '');

            if (text) {
              blocks.push(`#### ${text}`);
            }

            continue;
          }

          if (node.tagName === 'H5') {
            const text = normalizeWhitespace(node.textContent || '');

            if (text) {
              blocks.push(`##### ${text}`);
            }

            continue;
          }

          if (node.tagName === 'H6') {
            const text = normalizeWhitespace(node.textContent || '');

            if (text) {
              blocks.push(`###### ${text}`);
            }

            continue;
          }

          const text = normalizeWhitespace(node.innerText || node.textContent || '');

          if (text) {
            blocks.push(text);
          }
        }

        return blocks.join('\n\n').trim();
      }

      const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')];
      const versionPattern = new RegExp(`(^|\\s)${versionLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
      const targetHeading = headings.find((node) => versionPattern.test((node.textContent || '').replace(/\s+/g, ' ').trim()));

      if (!targetHeading) {
        return null;
      }

      const entry = targetHeading.closest('li');
      const article = entry?.querySelector('article');
      const title = normalizeWhitespace(targetHeading.textContent || '');
      const publishedAt = normalizeWhitespace(entry?.querySelector('time')?.textContent || '');
      const anchorId = targetHeading.querySelector('[data-anchor-id]')?.getAttribute('data-anchor-id') || '';
      const sourceUrl = anchorId ? `${changeLogUrl}#${anchorId}` : changeLogUrl;
      const body = article ? serializeArticle(article) : '';
      const markdown = [
        `### ${title}`,
        publishedAt ? `Published: ${publishedAt}` : '',
        `Source: ${sourceUrl}`,
        '',
        body,
      ]
        .filter((line) => line !== '')
        .join('\n\n')
        .trim();

      return {
        matchedVersion: versionLabel,
        title,
        publishedAt: publishedAt || null,
        sourceUrl: makeAbsoluteUrl(sourceUrl),
        releaseNotes: body || null,
        releaseNotesMarkdown: markdown || null,
      };
    }, {
      changeLogUrl: CHANGELOG_URL,
      versionLabel: targetVersion,
    });

    process.stdout.write(`${JSON.stringify(changelog ?? {
      matchedVersion: targetVersion,
      title: null,
      publishedAt: null,
      sourceUrl: CHANGELOG_URL,
      releaseNotes: null,
      releaseNotesMarkdown: null,
    }, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`Warning: Failed to fetch Codex app changelog: ${error instanceof Error ? error.message : String(error)}\n`);
  process.stdout.write(`${JSON.stringify({
    matchedVersion: null,
    title: null,
    publishedAt: null,
    sourceUrl: CHANGELOG_URL,
    releaseNotes: null,
    releaseNotesMarkdown: null,
  }, null, 2)}\n`);
  process.exit(0);
});
