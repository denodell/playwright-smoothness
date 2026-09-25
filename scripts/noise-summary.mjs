// Summarises repeated detection runs: for every numeric field in every result file, the
// min / median / max across runs and the spread (half the range, as a % of the median).
// Usage: node scripts/noise-summary.mjs <dir containing run-1/, run-2/, ...>
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? 'noise';
const runs = readdirSync(root)
  .filter((d) => d.startsWith('run-'))
  .sort();
const values = new Map(); // "file › path" -> number[]

function walk(prefix, value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (!values.has(prefix)) values.set(prefix, []);
    values.get(prefix).push(value);
  } else if (Array.isArray(value)) {
    // Arrays of runs inside a file are summarised by their median, per file.
    const nums = value.filter((v) => typeof v === 'number');
    if (nums.length === value.length && nums.length > 0) walk(prefix + '[median]', median(nums));
    else value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walk(prefix ? `${prefix}.${k}` : k, v);
  }
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

for (const run of runs) {
  const dir = join(root, run);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    walk(file.replace(/\.json$/, '') + ' › ', JSON.parse(readFileSync(join(dir, file), 'utf8')));
  }
}

const lines = [
  `# Noise across ${runs.length} runs`,
  '',
  '| metric | min | median | max | spread |',
  '|---|---:|---:|---:|---:|',
];
for (const [key, xs] of [...values.entries()].sort()) {
  if (xs.length < 2) continue;
  const med = median(xs);
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  const spread =
    med === 0
      ? max === min
        ? '0%'
        : 'n/a (median 0)'
      : `±${Math.round((50 * (max - min)) / Math.abs(med))}%`;
  const r = (x) => Math.round(x * 10) / 10;
  lines.push(`| ${key} | ${r(min)} | ${r(med)} | ${r(max)} | ${spread} |`);
}
console.log(lines.join('\n'));
