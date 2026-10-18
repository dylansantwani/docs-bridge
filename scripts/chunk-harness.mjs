#!/usr/bin/env node
// Split a harness into paste-sized chunks for tools that cap code length.
// Each chunk appends to window.__src; run the result with:
//   return await (0, eval)('(async()=>{' + window.__src + '})()')
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const [input, outDir, size = '9000'] = process.argv.slice(2);
let src = readFileSync(input, 'utf8').trimEnd();
const i = src.lastIndexOf('\n');
src = src.slice(0, i + 1) + 'return ' + src.slice(i + 1);
mkdirSync(outDir, { recursive: true });
const n = Math.ceil(src.length / Number(size));
for (let k = 0; k < n; k++) {
  const part = src.slice(k * Number(size), (k + 1) * Number(size));
  const head = k === 0 ? "window.__src='';" : '';
  writeFileSync(`${outDir}/chunk${k}.js`, `${head}window.__src+=${JSON.stringify(part)};return window.__src.length;`);
}
console.log(`${n} chunks, total ${src.length} chars`);
