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

function contextsIn(file, content, needle, before, after, limit) {
  let count = 0;
  let index = content.indexOf(needle);
  while (index !== -1 && count < limit) {
    count += 1;
    const start = Math.max(0, index - before);
    dump(`${needle} @ ${path.relative(assetsDir, file)}:${index}`, content.slice(start, index + needle.length + after));
    index = content.indexOf(needle, index + needle.length);
  }
  return count;
}

function contexts(needle, before, after, limit) {
  let count = 0;
  for (const file of files) {
    count += contextsIn(file, fs.readFileSync(file, 'utf8'), needle, before, after, limit - count);
  }
  console.log(`===== ${needle}: ${count} shown`);
}

const handlerFile = files.find(file => fs.readFileSync(file, 'utf8').includes('tryClaimExecution'));
const handlerSource = fs.readFileSync(handlerFile, 'utf8');
console.log(`handler chunk: ${path.relative(assetsDir, handlerFile)}`);

// The per-host resolver that falls back from the AppServerManager RPC.
const resolverMatch = handlerSource.match(
  /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{try\{var [A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\(\);let [\s\S]{0,300}?\.forHost\(\3\)\}catch\{\}/,
);
if (!resolverMatch) {
  console.log('resolver: not found');
} else {
  const name = resolverMatch[1];
  console.log(`resolver: ${name}`);
  dump(`resolver ${name} definition`, handlerSource.slice(resolverMatch.index, resolverMatch.index + 2500));
  const callRe = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\(`, 'g');
  const calls = [...handlerSource.matchAll(callRe)].map(match => match.index);
  const chained = calls.filter(index => /^[^;{}]{0,60}?\)\.sendRequest\(/.test(handlerSource.slice(index, index + 200)));
  console.log(`resolver ${name}: ${calls.length} calls in handler chunk, ${chained.length} chained .sendRequest`);
  for (const index of chained.slice(0, 15)) {
    console.log(`@${index}: ${handlerSource.slice(Math.max(0, index - 120), index + 220)}`);
  }
  for (const index of calls.filter(index => !chained.includes(index)).slice(0, 15)) {
    console.log(`@${index}: ${handlerSource.slice(Math.max(0, index - 120), index + 220)}`);
  }
}

contexts('`thread/list`,{archived:!0', 1500, 900, 4);
contexts('dispatchMessageFromView:(e,t)=>', 300, 300, 12);
