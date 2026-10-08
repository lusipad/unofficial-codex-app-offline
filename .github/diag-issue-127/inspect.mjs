// Temporary diagnostic for issue #127: print the bundle shapes around the
// Computer Use node_repl bridge anchors of the current Store package.
import fs from 'node:fs';
import path from 'node:path';

const assetsDir = process.argv[2];
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
})(assetsDir);

function dump(label, text) {
  console.log(`----- ${label} (${text.length} chars)`);
  for (let i = 0; i < text.length; i += 240) console.log(`| ${text.slice(i, i + 240)}`);
}

function contexts(needle, before, after, limit) {
  let count = 0;
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    let index = content.indexOf(needle);
    while (index !== -1 && count < limit) {
      count += 1;
      const start = Math.max(0, index - before);
      dump(`${needle} @ ${path.relative(assetsDir, file)}:${index}`, content.slice(start, index + needle.length + after));
      index = content.indexOf(needle, index + needle.length);
    }
  }
  console.log(`===== ${needle}: ${count} shown`);
}

console.log(`webview js files: ${files.length}`);
for (const needle of [
  'AppServerManager RPC is not connected',
  'tryClaimExecution',
  'dynamicToolCalls',
  '.forHost(',
  'mcpServer/tool/call',
  'record_private_review',
]) {
  const hits = files
    .map(file => [path.relative(assetsDir, file), fs.readFileSync(file, 'utf8').split(needle).length - 1])
    .filter(([, n]) => n > 0);
  console.log(`== ${needle}: ${JSON.stringify(hits)}`);
}

contexts('AppServerManager RPC is not connected', 1200, 600, 6);
contexts('tryClaimExecution', 3500, 3000, 4);
contexts('.forHost(', 300, 200, 40);

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  if (!content.includes('tryClaimExecution')) continue;
  dump(`head of ${path.relative(assetsDir, file)}`, content.slice(0, 6000));
  dump(`tail of ${path.relative(assetsDir, file)}`, content.slice(-3000));
}
