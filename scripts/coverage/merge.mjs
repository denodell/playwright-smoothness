import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unbundle } from './bundles.mjs';

const [rawDir, pageDir, cacheDir, reportDir] = process.argv.slice(2);
const repo = join(import.meta.dirname, '..', '..');
const inRepo = (url) => url.startsWith('file://') && fileURLToPath(url).startsWith(join(repo, 'packages'));
const inFolder = (url, folder) => inRepo(url) && fileURLToPath(url).split(/[\\/]/).includes(folder);
const bundled = (url) => inFolder(url, 'dist');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const lineLengths = (text) => text.split(/\n/).map((l) => l.replace(/\r$/, '').length);
const sameLengths = (a, b) => a.length === b.length && a.every((n, i) => n === b[i]);

function cachedCompilations() {
  const byLengths = new Map();
  if (!cacheDir || !existsSync(cacheDir)) return byLengths;
  for (const sub of readdirSync(cacheDir)) {
    const dir = join(cacheDir, sub);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      const text = readFileSync(join(dir, f), 'utf8');
      for (const t of [text, text.slice(text.indexOf('\n') + 1)]) byLengths.set(lineLengths(t).join(','), t);
    }
  }
  return byLengths;
}

const compiled = cachedCompilations();

function executedText(url, lengths) {
  const path = fileURLToPath(url);
  if (!existsSync(path)) return null;
  const onDisk = readFileSync(path, 'utf8');
  if (!lengths || sameLengths(lineLengths(onDisk), lengths)) return onDisk;
  return compiled.get(lengths.join(',')) ?? null;
}

function executedSources() {
  const sources = new Map();
  for (const f of readdirSync(rawDir)) {
    if (!f.endsWith('.json')) continue;
    const cov = readJson(join(rawDir, f));
    for (const { url } of cov.result) {
      if (sources.has(url) || !inRepo(url) || bundled(url)) continue;
      const text = executedText(url, cov['source-map-cache']?.[url]?.lineLengths);
      if (text !== null) sources.set(url, text);
    }
  }
  return sources;
}

function place(script, sources) {
  const byUrl = new Map();
  const fns = script.functions
    .slice(1)
    .sort(
      (a, b) =>
        a.ranges[0].startOffset - b.ranges[0].startOffset || b.ranges[0].endOffset - a.ranges[0].endOffset,
    );
  let outer = null;
  for (const fn of fns) {
    const { startOffset, endOffset } = fn.ranges[0];
    if (!outer || startOffset >= outer.end) {
      outer = null;
      const text = script.source.slice(startOffset, endOffset);
      if (text.length < 12) continue;
      for (const [url, source] of sources) {
        const at = source.indexOf(text);
        if (at >= 0 && source.indexOf(text, at + 1) < 0) {
          outer = { end: endOffset, delta: at - startOffset, url };
          break;
        }
      }
      if (!outer) continue;
    }
    const ranges = fn.ranges.map((r) => ({
      ...r,
      startOffset: r.startOffset + outer.delta,
      endOffset: r.endOffset + outer.delta,
    }));
    if (!byUrl.has(outer.url)) byUrl.set(outer.url, []);
    byUrl.get(outer.url).push({ functionName: fn.functionName, isBlockCoverage: fn.isBlockCoverage, ranges });
  }
  return byUrl;
}

rmSync(reportDir, { recursive: true, force: true });
mkdirSync(reportDir, { recursive: true });
const bundles = unbundle({
  rawDir,
  reportDir,
  sourcesDir: join(reportDir, '..', 'bundled-sources'),
  executedText,
  isSource: (url) => inFolder(url, 'src'),
  isBundle: bundled,
});
console.log(
  `Bundled code: ${bundles.mapped} scripts mapped to their sources, ${bundles.dropped} left out, ${bundles.unmapped} unrun ranges unmapped`,
);
const sources = executedSources();
const placed = new Set();
let scripts = 0;
let written = 0;
for (const f of existsSync(pageDir) ? readdirSync(pageDir) : []) {
  for (const script of readJson(join(pageDir, f))) {
    scripts++;
    const result = [...place(script, sources)].map(([url, functions], i) => {
      placed.add(url);
      return { scriptId: String(i), url, functions };
    });
    if (result.length)
      writeFileSync(join(reportDir, `page-${written++}.json`), JSON.stringify({ result }));
  }
}
console.log(
  `Browser coverage: ${written} of ${scripts} page scripts placed, in ${[...placed].map((u) => basename(fileURLToPath(u))).join(', ')}`,
);
