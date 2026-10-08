// Temporary diagnostic for issue #127: print the 26.1002 shapes of the
// archived settings panel around the `archivedChats:` prop.
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

for (const needle of ['archivedChats:', 'isError:', 'onLoadNextPage:']) {
  const hits = files
    .map(file => [path.relative(assetsDir, file), fs.readFileSync(file, 'utf8').split(needle).length - 1])
    .filter(([, n]) => n > 0 && n < 50);
  console.log(`== ${needle}: ${JSON.stringify(hits.slice(0, 40))}`);
}
let shown = 0;
for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  let index = content.indexOf('archivedChats:');
  while (index !== -1 && shown < 6) {
    shown += 1;
    dump(`archivedChats: @ ${path.relative(assetsDir, file)}:${index}`, content.slice(Math.max(0, index - 4000), index + 1600));
    index = content.indexOf('archivedChats:', index + 1);
  }
}
