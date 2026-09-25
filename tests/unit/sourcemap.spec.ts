import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { decodeSegment } from '../../src/sourcemap/vlq.js';
import { SourceMap } from '../../src/sourcemap/sourcemap.js';
import { NameResolver, generatedName, type FetchText } from '../../src/sourcemap/resolve.js';

const vlq = (s: string) => decodeSegment(s, 0, s.length);

test('VLQ: known values', () => {
  expect(vlq('A')).toEqual([0]);
  expect(vlq('C')).toEqual([1]);
  expect(vlq('D')).toEqual([-1]);
  expect(vlq('gB')).toEqual([16]);
  expect(vlq('2HwcO')).toEqual([123, 456, 7]);
  expect(vlq('AAgBC')).toEqual([0, 0, 16, 1]);
});

test('VLQ: malformed input returns null instead of throwing', () => {
  expect(vlq('g')).toBeNull(); // continuation bit with nothing after it
  expect(vlq('A!')).toBeNull();
  expect(vlq('gggggggggggB')).toBeNull(); // too many digits
});

// Two generated lines. Line 0: col 0 → a.js 0:0; col 4 → a.js 0:9, name "busyWait".
// Line 1: col 2 → b.js 3:4 (deltas carry across lines).
const MAP = JSON.stringify({
  version: 3,
  sources: ['a.js', 'b.js'],
  names: ['busyWait'],
  mappings: 'AAAA,IAASA;ECGL',
});

test('source map: lookups, deltas across lines, and names', () => {
  const map = SourceMap.parse(MAP, 'http://x/dist/app.js.map') as SourceMap;
  expect(map.sources).toEqual(['http://x/dist/a.js', 'http://x/dist/b.js']);
  expect(map.originalPositionFor(0, 5)).toEqual({
    source: 'http://x/dist/a.js',
    line: 0,
    column: 9,
    name: 'busyWait',
  });
  expect(map.originalPositionFor(0, 1)).toEqual({ source: 'http://x/dist/a.js', line: 0, column: 0 });
  expect(map.originalPositionFor(1, 2)).toEqual({ source: 'http://x/dist/b.js', line: 3, column: 4 });
  expect(map.originalPositionFor(1, 0)).toBeUndefined(); // before the first segment
  expect(map.originalPositionFor(7, 0)).toBeUndefined(); // past the last line
});

test('source map: unusable maps are rejected with a reason', () => {
  expect(SourceMap.parse('{')).toMatch(/isn't valid JSON/);
  expect(SourceMap.parse(JSON.stringify({ version: 2, sources: [], mappings: '' }))).toMatch(/version 2/);
  expect(SourceMap.parse(JSON.stringify({ version: 3, sections: [] }))).toMatch(/index source maps/);
  expect(SourceMap.parse(")]}'\n" + MAP)).toBeInstanceOf(SourceMap); // XSSI prefix
});

test('generatedName: the identifier before a V8 function position', () => {
  const at = (text: string) => generatedName(text, text.lastIndexOf('('));
  expect(at('function G0(l){')).toEqual({ name: 'G0', column: 9 });
  expect(at('class A{onCheckout(){')).toEqual({ name: 'onCheckout', column: 8 });
  expect(at('x.y=function (a){')).toEqual({ name: 'y', column: 2 });
  expect(at('const handler = async (e) =>')).toEqual({ name: 'handler', column: 6 });
  expect(at('[1].map(function(a){')).toBeNull();
  expect(generatedName('return (a)=>a', 7)).toBeNull();
});

async function minified(): Promise<{ js: string; map: string }> {
  const source = [
    'export function busyWait(ms) {',
    '  const end = performance.now() + ms;',
    '  while (performance.now() < end) {}',
    '}',
    'export class Cart {',
    '  onCheckout() {',
    '    busyWait(150);',
    '  }',
    '}',
  ].join('\n');
  const out = await build({
    stdin: { contents: source, sourcefile: 'src/cart.js', loader: 'js' },
    bundle: false,
    minify: true,
    format: 'esm',
    sourcemap: 'external',
    outfile: 'dist/cart.js',
    write: false,
  });
  const js = out.outputFiles.find((f) => f.path.endsWith('.js'))!.text + '//# sourceMappingURL=cart.js.map\n';
  const map = out.outputFiles.find((f) => f.path.endsWith('.map'))!.text;
  return { js, map };
}

/** A V8-style frame (1-based, pointing at the "(" of the parameters) for a minified function. */
function frameFor(js: string, search: RegExp) {
  const lines = js.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = search.exec(lines[i]!);
    if (m) return { url: 'http://x/dist/cart.js', line: i + 1, column: m.index + m[0].length + 1 };
  }
  throw new Error(`not found: ${search}`);
}

test('resolver: minified esbuild output maps back to the original names and lines', async () => {
  const { js, map } = await minified();
  const fetches: string[] = [];
  const fetchText: FetchText = async (url) => {
    fetches.push(url);
    if (url.endsWith('cart.js')) return { text: js };
    if (url.endsWith('cart.js.map')) return { text: map };
    throw new Error('404');
  };
  const resolver = new NameResolver(fetchText);
  // Whatever esbuild renamed busyWait to, it's the first function in the output.
  const busy = frameFor(js, /function ([\w$]+)(?=\()/);
  expect(await resolver.resolve({ fn: 'x', ...busy })).toEqual({
    name: 'busyWait',
    source: 'http://x/dist/src/cart.js', // sources resolve against the map's URL
    line: 1,
    column: 17,
  });
  const onCheckout = frameFor(js, /onCheckout(?=\()/);
  expect(await resolver.resolve({ fn: 'onCheckout', ...onCheckout })).toMatchObject({
    name: 'onCheckout',
    line: 6,
  });
  expect(fetches.filter((u) => u.endsWith('cart.js'))).toHaveLength(1); // cached
  expect(await resolver.failures()).toEqual([]);
});

test('resolver: inline data: maps and the SourceMap header both work', async () => {
  const { js, map } = await minified();
  const inline = js.replace(
    /\/\/# sourceMappingURL=.*\n$/,
    `//# sourceMappingURL=data:application/json;base64,${Buffer.from(map).toString('base64')}\n`,
  );
  const a = new NameResolver(async () => ({ text: inline }));
  expect((await a.resolve({ fn: 'x', ...frameFor(inline, /function ([\w$]+)(?=\()/) }))!.name).toBe(
    'busyWait',
  );

  const noComment = js.replace(/\/\/# sourceMappingURL=.*\n$/, '');
  const b = new NameResolver(async (url) =>
    url.endsWith('.map') ? { text: map } : { text: noComment, sourceMapHeader: 'cart.js.map' },
  );
  expect((await b.resolve({ fn: 'x', ...frameFor(noComment, /function ([\w$]+)(?=\()/) }))!.name).toBe(
    'busyWait',
  );
});

test('resolver: no map, broken maps and unfetchable scripts resolve to null and are reported', async () => {
  const noMap = new NameResolver(async () => ({ text: 'function a(){}' }));
  expect(await noMap.resolve({ fn: 'a', url: 'http://x/a.js', line: 1, column: 11 })).toBeNull();
  expect(await noMap.failures()).toEqual(['http://x/a.js: it has no sourceMappingURL']);

  const broken = new NameResolver(async (url) => ({
    text: url.endsWith('.map') ? '{nope' : 'function a(){}\n//# sourceMappingURL=a.js.map',
  }));
  expect(await broken.resolve({ fn: 'a', url: 'http://x/a.js', line: 1, column: 11 })).toBeNull();
  expect((await broken.failures())[0]).toMatch(/isn't valid JSON/);

  const offline = new NameResolver(async () => {
    throw new Error('HTTP 404');
  });
  expect(await offline.resolve({ fn: 'a', url: 'http://x/a.js', line: 1, column: 11 })).toBeNull();
  expect((await offline.failures())[0]).toMatch(/could not load its source map \(Error: HTTP 404\)/);

  // Native and eval'd code has no URL; nothing is fetched.
  expect(await offline.resolve({ fn: 'now', url: '', line: 0, column: 0 })).toBeNull();
});
