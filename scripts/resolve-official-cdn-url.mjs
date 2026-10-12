import process from 'node:process';
import { pathToFileURL } from 'node:url';

// Official package source documented in OpenAI's enterprise deployment guide
// (https://learn.chatgpt.com/docs/enterprise/windows-deployment). The blob
// metadata headers carry the package identity and version, so a single HEAD
// request resolves the current Store-signed release without any third-party
// resolver service.
const DEFAULT_URL = 'https://persistent.oaistatic.com/codex-app-prod/ChatGPT-x64.msix';

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

function headerValue(headers, name) {
  const value = headers.get(name);
  return value === null ? null : String(value).trim();
}

export function parseOfficialCdnHeaders({ url, headers, packageFamilyName, resolvedAt }) {
  const identity = headerValue(headers, 'x-ms-meta-package_identity');
  const version = headerValue(headers, 'x-ms-meta-package_version');
  const architecture = headerValue(headers, 'x-ms-meta-architecture');
  const etag = headerValue(headers, 'etag');
  const sizeHeader = headerValue(headers, 'content-length');
  const size = sizeHeader === null ? null : Number.parseInt(sizeHeader, 10);

  if (!identity) {
    throw new Error('The official CDN response is missing the x-ms-meta-package_identity header.');
  }

  if (!version) {
    throw new Error('The official CDN response is missing the x-ms-meta-package_version header.');
  }

  if (!etag) {
    throw new Error('The official CDN response is missing the ETag header.');
  }

  if (sizeHeader !== null && !Number.isFinite(size)) {
    throw new Error(`The official CDN response has an unparsable Content-Length header: ${sizeHeader}`);
  }

  const packageName = packageFamilyName.split('_')[0];
  if (identity.toLowerCase() !== packageName.toLowerCase()) {
    throw new Error(`The official CDN package identity '${identity}' does not match the configured package '${packageName}'.`);
  }

  const fileName = new URL(url).pathname.split('/').filter(Boolean).pop();
  if (!fileName) {
    throw new Error(`Cannot derive a file name from the official CDN URL: ${url}`);
  }

  return {
    packageFamilyName,
    packageName: identity,
    ring: 'Retail',
    resolvedAt,
    selected: {
      fileName,
      href: url,
      expiresAt: null,
      sha1: null,
      etag,
      size,
      architecture,
    },
    candidates: [],
    version,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageFamilyName = args['package-family-name'] || process.env.CODEX_PACKAGE_FAMILY_NAME;
  const url = args.url || process.env.CODEX_OFFICIAL_CDN_URL || DEFAULT_URL;
  const timeoutMs = Number.parseInt(args.timeout || process.env.CODEX_STORE_RESOLVER_TIMEOUT || '120000', 10);

  if (!packageFamilyName) {
    throw new Error('Missing --package-family-name');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });

    if (!response.ok) {
      throw new Error(`Official CDN HEAD request returned HTTP ${response.status} for ${url}`);
    }

    const resolved = parseOfficialCdnHeaders({
      url,
      headers: response.headers,
      packageFamilyName,
      resolvedAt: new Date().toISOString(),
    });
    resolved.candidates = [resolved.selected];

    process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
  }
  finally {
    clearTimeout(timeout);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
