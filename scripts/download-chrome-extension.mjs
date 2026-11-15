import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

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

function extensionIdFromPublicKey(publicKey) {
  const hash = createHash('sha256').update(publicKey).digest().subarray(0, 16);
  return Array.from(hash, (byte) =>
    String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 0x0f)),
  ).join('');
}

function readVarint(buffer, start) {
  let value = 0n;
  let shift = 0n;
  let position = start;

  while (position < buffer.length) {
    const byte = buffer[position];
    position += 1;
    value |= BigInt(byte & 0x7f) << shift;

    if ((byte & 0x80) === 0) {
      return { value: Number(value), position };
    }

    shift += 7n;
  }

  throw new Error('Unexpected end of protobuf varint.');
}

function parseProtobufFields(buffer) {
  const fields = [];
  let position = 0;

  while (position < buffer.length) {
    const tag = readVarint(buffer, position);
    position = tag.position;

    const field = tag.value >> 3;
    const wire = tag.value & 0x07;

    if (wire === 0) {
      const parsed = readVarint(buffer, position);
      position = parsed.position;
      fields.push({ field, wire, value: parsed.value });
      continue;
    }

    if (wire === 2) {
      const length = readVarint(buffer, position);
      position = length.position;
      const value = buffer.subarray(position, position + length.value);
      position += length.value;
      fields.push({ field, wire, value });
      continue;
    }

    throw new Error(`Unsupported protobuf wire type ${wire}.`);
  }

  return fields;
}

function readCrx(crxPath, expectedExtensionId) {
  const crx = fs.readFileSync(crxPath);
  const magic = crx.subarray(0, 4).toString('ascii');

  if (magic !== 'Cr24') {
    throw new Error(`Downloaded file is not a CRX archive: ${crxPath}`);
  }

  const version = crx.readUInt32LE(4);

  if (version === 2) {
    const publicKeyLength = crx.readUInt32LE(8);
    const signatureLength = crx.readUInt32LE(12);
    const publicKey = crx.subarray(16, 16 + publicKeyLength);
    const zipOffset = 16 + publicKeyLength + signatureLength;
    const extensionId = extensionIdFromPublicKey(publicKey);

    if (extensionId !== expectedExtensionId) {
      throw new Error(`CRX public key produced extension id ${extensionId}, expected ${expectedExtensionId}.`);
    }

    return { version, publicKey, zipOffset };
  }

  if (version !== 3) {
    throw new Error(`Unsupported CRX version ${version}.`);
  }

  const headerSize = crx.readUInt32LE(8);
  const header = crx.subarray(12, 12 + headerSize);
  const fields = parseProtobufFields(header);
  const proofs = fields.filter((field) => field.field === 2 && Buffer.isBuffer(field.value));
  const selectedProof = proofs
    .map((proof) => parseProtobufFields(proof.value).find((field) => field.field === 1)?.value)
    .filter(Boolean)
    .find((publicKey) => extensionIdFromPublicKey(publicKey) === expectedExtensionId);

  if (!selectedProof) {
    throw new Error(`CRX header does not contain a public key for extension id ${expectedExtensionId}.`);
  }

  return {
    version,
    publicKey: selectedProof,
    zipOffset: 12 + headerSize,
  };
}

function powershellQuote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

async function downloadCrx(extensionId, chromeVersion) {
  const url = new URL('https://clients2.google.com/service/update2/crx');
  url.searchParams.set('response', 'redirect');
  url.searchParams.set('prodversion', chromeVersion);
  url.searchParams.set('acceptformat', 'crx2,crx3');
  url.searchParams.set('x', `id=${extensionId}&installsource=ondemand&uc`);

  const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/${chromeVersion} Safari/537.36`;

  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': userAgent,
      },
    });

    if (!response.ok) {
      throw new Error(`Chrome Web Store CRX download failed with HTTP ${response.status}.`);
    }

    return Buffer.from(await response.arrayBuffer());
  }
  catch (error) {
    const tempCrxPath = path.join(
      fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'codex-chrome-extension-')),
      'codex.crx',
    );
    const fallback = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        [
          '$ProgressPreference = "SilentlyContinue"',
          `Invoke-WebRequest -Uri ${powershellQuote(url.toString())} -OutFile ${powershellQuote(tempCrxPath)} -MaximumRedirection 5 -Headers @{ 'User-Agent' = ${powershellQuote(userAgent)} }`,
        ].join('; '),
      ],
      { stdio: 'inherit' },
    );

    if (fallback.status !== 0) {
      throw error;
    }

    return fs.readFileSync(tempCrxPath);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const extensionId = args['extension-id'];
  const destination = args.destination;
  const sourceCrx = args['source-crx'];
  const chromeVersion = args['chrome-version'] || process.env.CODEX_CHROME_EXTENSION_CHROME_VERSION || '145.0.0.0';

  if (!/^[a-p]{32}$/.test(extensionId || '')) {
    throw new Error('Missing or invalid --extension-id.');
  }

  if (!destination) {
    throw new Error('Missing --destination.');
  }

  const destinationRoot = path.resolve(destination);
  fs.rmSync(destinationRoot, { recursive: true, force: true });
  fs.mkdirSync(destinationRoot, { recursive: true });

  const crxPath = path.join(destinationRoot, 'codex.crx');
  const zipPath = path.join(destinationRoot, 'codex.zip');
  const unpackedPath = path.join(destinationRoot, 'unpacked');

  if (sourceCrx) {
    fs.copyFileSync(path.resolve(sourceCrx), crxPath);
  } else {
    fs.writeFileSync(crxPath, await downloadCrx(extensionId, chromeVersion));
  }

  const crxInfo = readCrx(crxPath, extensionId);
  const crx = fs.readFileSync(crxPath);
  fs.writeFileSync(zipPath, crx.subarray(crxInfo.zipOffset));
  fs.mkdirSync(unpackedPath, { recursive: true });

  let extracted = false;
  try {
    const tar = spawnSync('tar.exe', ['-xf', zipPath, '-C', unpackedPath], { stdio: 'inherit' });
    if (tar.status === 0) {
      extracted = true;
    }
  } catch (_e) {}

  if (!extracted) {
    const expand = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Expand-Archive -LiteralPath ${powershellQuote(zipPath)} -DestinationPath ${powershellQuote(unpackedPath)} -Force`,
      ],
      { stdio: 'inherit' },
    );

    if (expand.status !== 0) {
      throw new Error('Failed to extract Chrome extension archive.');
    }
  }

  fs.rmSync(zipPath, { force: true });

  const manifestPath = path.join(unpackedPath, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.key = manifest.key || crxInfo.publicKey.toString('base64');

  const unpackedExtensionId = extensionIdFromPublicKey(Buffer.from(manifest.key, 'base64'));
  if (unpackedExtensionId !== extensionId) {
    throw new Error(`Unpacked manifest key produced extension id ${unpackedExtensionId}, expected ${extensionId}.`);
  }

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const info = {
    extensionId,
    name: manifest.name,
    version: manifest.version,
    crxVersion: crxInfo.version,
    crxFile: 'codex.crx',
    unpackedDirectory: 'unpacked',
    crxSha256: createHash('sha256').update(crx).digest('hex'),
    source: sourceCrx ? 'local-crx' : 'chrome-web-store',
  };

  fs.writeFileSync(path.join(destinationRoot, 'extension-info.json'), `${JSON.stringify(info, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
