import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  GREATEST_LOWER_BOUND,
  LEAST_UPPER_BOUND,
  TraceMap,
  originalPositionFor,
} from '@jridgewell/trace-mapping';
import { GenMapping, addMapping, setSourceContent, toEncodedMap } from '@jridgewell/gen-mapping';

const lineLengths = (text) => text.split(/\n/).map((l) => l.replace(/\r$/, '').length);

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function toLineColumn(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo] };
}

function lookup(map, line, column) {
  for (const bias of [GREATEST_LOWER_BOUND, LEAST_UPPER_BOUND]) {
    const p = originalPositionFor(map, { line, column, bias });
    if (p.source !== null && p.line !== null) return p;
  }
  return null;
}

function makeResolver(firstMap, isSource, isBundle) {
  const bundleMaps = new Map();
  const bundleMap = (url) => {
    if (!bundleMaps.has(url)) {
      const path = `${fileURLToPath(url)}.map`;
      bundleMaps.set(url, existsSync(path) ? new TraceMap(readFileSync(path, 'utf8'), url) : null);
    }
    return bundleMaps.get(url);
  };
  return (line, column) => {
    let p = lookup(firstMap, line, column);
    for (let hops = 0; p && hops < 3; hops++) {
      if (isSource(p.source)) return p;
      if (!isBundle(p.source)) return null;
      const next = bundleMap(p.source);
      p = next ? lookup(next, p.line, p.column) : null;
    }
    return null;
  };
}

function identityMap(url, text) {
  const map = new GenMapping({ file: url });
  setSourceContent(map, url, text);
  text.split('\n').forEach((line, i) => {
    for (let c = 0; c <= line.length; c++) {
      addMapping(map, { generated: { line: i + 1, column: c }, source: url, original: { line: i + 1, column: c } });
    }
  });
  return toEncodedMap(map);
}

export function unbundle({ rawDir, reportDir, sourcesDir, executedText, isSource, isBundle }) {
  mkdirSync(sourcesDir, { recursive: true });
  const originals = new Map();
  const original = (url) => {
    if (!originals.has(url)) {
      const text = readFileSync(fileURLToPath(url), 'utf8');
      originals.set(url, { text, starts: lineStarts(text) });
    }
    return originals.get(url);
  };
  let n = 0;
  let mapped = 0;
  let dropped = 0;
  let unmapped = 0;
  for (const f of readdirSync(rawDir)) {
    if (!f.endsWith('.json')) continue;
    const path = join(rawDir, f);
    const cov = JSON.parse(readFileSync(path, 'utf8'));
    const keep = [];
    const out = { result: [], 'source-map-cache': {} };
    for (const script of cov.result) {
      if (!isBundle(script.url)) {
        keep.push(script);
        continue;
      }
      const cached = cov['source-map-cache']?.[script.url];
      const text = executedText(script.url, cached?.lineLengths);
      const firstMap = cached?.data
        ? new TraceMap(cached.data, cached.url ?? script.url)
        : existsSync(`${fileURLToPath(script.url)}.map`)
          ? new TraceMap(readFileSync(`${fileURLToPath(script.url)}.map`, 'utf8'), script.url)
          : null;
      if (text === null || !firstMap) {
        dropped++;
        continue;
      }
      mapped++;
      const starts = lineStarts(text);
      const resolve = makeResolver(firstMap, isSource, isBundle);
      const at = (offset) => {
        const { line, column } = toLineColumn(starts, offset);
        return resolve(line, column);
      };
      const bySource = new Map();
      const root = script.functions[0]?.ranges[0];
      if (root && root.count > 0) {
        const loaded = new Set();
        text.split('\n').forEach((line, i) => {
          for (const column of [0, Math.max(0, line.length - 1)]) {
            const p = resolve(i + 1, column);
            if (p) loaded.add(p.source);
          }
        });
        for (const source of loaded) {
          const { text: sourceText } = original(source);
          const whole = { startOffset: 0, endOffset: sourceText.length, count: root.count };
          bySource.set(source, [{ functionName: '', isBlockCoverage: true, ranges: [whole] }]);
        }
      }
      for (const fn of script.functions) {
        let target = null;
        const ranges = [];
        for (const r of fn.ranges) {
          if (r.endOffset <= r.startOffset) continue;
          const a = at(r.startOffset);
          const b = at(r.endOffset - 1);
          if (!a || !b || a.source !== b.source) {
            if (r.count === 0 && fn !== script.functions[0]) unmapped++;
            if (!ranges.length) break;
            continue;
          }
          if (target === null) target = a.source;
          if (a.source !== target) continue;
          const o = original(target);
          const start = o.starts[a.line - 1] + a.column;
          const end = Math.min(o.text.length, o.starts[b.line - 1] + b.column + 1);
          if (end > start) ranges.push({ startOffset: start, endOffset: end, count: r.count });
          else {
            if (r.count === 0) unmapped++;
            if (!ranges.length) break;
          }
        }
        if (!ranges.length) continue;
        if (!bySource.has(target)) bySource.set(target, []);
        bySource.get(target).push({ functionName: fn.functionName, isBlockCoverage: fn.isBlockCoverage, ranges });
      }
      for (const [source, functions] of bySource) {
        const { text: sourceText } = original(source);
        const file = join(sourcesDir, `${n++}.js`);
        writeFileSync(file, sourceText);
        const url = pathToFileURL(file).href;
        out.result.push({ scriptId: String(out.result.length), url, functions });
        out['source-map-cache'][url] = {
          lineLengths: lineLengths(sourceText),
          data: identityMap(source, sourceText),
          url: null,
        };
      }
    }
    writeFileSync(join(reportDir, f), JSON.stringify({ ...cov, result: keep }));
    if (out.result.length) writeFileSync(join(reportDir, `bundle-${f}`), JSON.stringify(out));
  }
  return { mapped, dropped, unmapped };
}
