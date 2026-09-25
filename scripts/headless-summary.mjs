// Collates headless-mode signal records (one JSON per Playwright version × mode) into a
// markdown table, and checks the library's detection rule against every record.
// Usage: node scripts/headless-summary.mjs <dir with *headless-mode.json files, any depth>
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (name.endsWith('headless-mode.json')) yield p;
  }
}

/**
 * Mirrors detectHeadlessMode in src/environment.ts, and must be kept in sync with it. Reads CDP
 * Browser.getVersion only, which page userAgent overrides don't affect.
 */
function detect(r) {
  const product = r.cdpProduct ?? '';
  if (product.startsWith('HeadlessChrome/')) return 'headless-shell';
  if (!product.startsWith('Chrome/')) return 'unknown';
  if (/HeadlessChrome\//.test(r.cdpUserAgent ?? '')) return 'new-headless';
  if (/Chrome\//.test(r.cdpUserAgent ?? '')) return 'headed';
  return 'unknown';
}

const expected = {
  'mode-headless-shell': 'headless-shell',
  'mode-new-headless': 'new-headless',
  'mode-headed': 'headed',
};
const records = [...files(process.argv[2] ?? '.')].map((f) => JSON.parse(readFileSync(f, 'utf8')));
records.sort(
  (a, b) =>
    a.playwrightVersion.localeCompare(b.playwrightVersion, undefined, { numeric: true }) ||
    a.project.localeCompare(b.project),
);

const rows = [
  '| Playwright | Chrome | project | CDP product | CDP UA browser token | UA-CH brands | executablePath tail | rule says | correct |',
  '|---|---|---|---|---|---|---|---|---|',
];
let wrong = 0;
for (const r of records) {
  const got = detect(r);
  const ok = got === expected[r.project];
  if (!ok) wrong++;
  const uaToken = (r.cdpUserAgent ?? '').match(/(HeadlessChrome|Chrome)\/[\d.]+/)?.[0] ?? '?';
  const exe = (r.executablePath ?? '').split(/[\\/]/).slice(-3).join('/');
  rows.push(
    `| ${r.playwrightVersion} | ${r.browserVersion} | ${r.project} | ${r.cdpProduct} | ${uaToken} | ${(r.uaDataBrands ?? []).join(', ')} | ${exe} | ${got} | ${ok ? 'yes' : '**NO**'} |`,
  );
}
console.log(rows.join('\n'));
console.log(`\n${records.length} records, ${wrong} misdetected.`);
process.exitCode = wrong ? 1 : 0;
