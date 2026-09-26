// Turns minified function names from the CPU profile back into the names in your source,
// using the page's source maps. A profile gives each function's position in the bundle (V8
// points at the "(" of its parameter list), so the minified name is the identifier just before
// it, and the source map says what that identifier was called originally.
import { SourceMap } from './sourcemap.js';

/** A function as the profile saw it. Line and column are 1-based. */
export interface GeneratedFrame {
  fn: string;
  url: string;
  line: number;
  column: number;
}

/** Where the function is in your source. Line and column are 1-based. */
export interface ResolvedFrame {
  name?: string;
  source: string;
  line: number;
  column: number;
}

export interface FetchedText {
  text: string;
  /** The SourceMap (or X-SourceMap) response header, if any. */
  sourceMapHeader?: string;
}

export type FetchText = (url: string) => Promise<FetchedText>;

/** Scripts and maps longer than this (in characters) aren't mapped; a large app's map is a few MB. */
const MAX_SCRIPT_BYTES = 30 * 1024 * 1024;
const MAX_MAP_BYTES = 60 * 1024 * 1024;

interface Script {
  lines: string[];
  map: SourceMap;
}

const RESERVED = new Set([
  'function',
  'async',
  'return',
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'new',
  'typeof',
  'await',
]);

/** The minified name at a V8 function position, or null for an anonymous function. */
export function generatedName(lineText: string, column0: number): { name: string; column: number } | null {
  let i = column0 - 1;
  while (i >= 0 && /\s/.test(lineText[i]!)) i--;
  let end = i + 1;
  while (i >= 0 && /[\w$]/.test(lineText[i]!)) i--;
  let start = i + 1;
  let name = lineText.slice(start, end);
  if (name && !RESERVED.has(name) && !/^\d/.test(name)) return { name, column: start };
  // `x = function(`, `x = async (`, `x: (`: an anonymous function assigned to a name.
  const before = lineText.slice(Math.max(0, start - 120), start);
  const m = /([\w$]+)\s*[:=]\s*(?:async\s*)?$/.exec(before);
  if (!m) return null;
  end = Math.max(0, start - 120) + m.index + m[1]!.length;
  start = end - m[1]!.length;
  name = m[1]!;
  return RESERVED.has(name) ? null : { name, column: start };
}

function sourceMappingUrl(text: string): string | null {
  const tail = text.slice(-2000);
  const all = [...tail.matchAll(/\/[/*][#@]\s*sourceMappingURL=([^\s*'"]+)/g)];
  return all.length ? all[all.length - 1]![1]! : null;
}

function decodeDataUrl(url: string): string | null {
  const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  try {
    return m[1] ? Buffer.from(m[2]!, 'base64').toString('utf8') : decodeURIComponent(m[2]!);
  } catch {
    return null;
  }
}

export class NameResolver {
  private readonly scripts = new Map<string, Promise<Script | string>>();

  constructor(private readonly fetchText: FetchText) {}

  /** Why each script's map couldn't be used, for the result's notes. */
  async failures(): Promise<string[]> {
    const out: string[] = [];
    for (const [url, p] of this.scripts) {
      const s = await p;
      if (typeof s === 'string') out.push(`${url}: ${s}`);
    }
    return out;
  }

  private load(url: string): Promise<Script | string> {
    let p = this.scripts.get(url);
    if (!p) {
      p = this.loadScript(url).catch(
        (err: unknown) => `could not load its source map (${String(err).slice(0, 120)})`,
      );
      this.scripts.set(url, p);
    }
    return p;
  }

  private async loadScript(url: string): Promise<Script | string> {
    const script = await this.fetchText(url);
    if (script.text.length > MAX_SCRIPT_BYTES) return 'the script is too large to map';
    const ref = script.sourceMapHeader ?? sourceMappingUrl(script.text);
    if (!ref) return 'it has no sourceMappingURL';
    let mapUrl: string | undefined;
    let json: string | null;
    if (ref.startsWith('data:')) {
      json = decodeDataUrl(ref);
      if (json === null) return 'its inline source map could not be decoded';
    } else {
      mapUrl = new URL(ref, url).href;
      json = (await this.fetchText(mapUrl)).text;
    }
    if (json.length > MAX_MAP_BYTES) return 'its source map is too large';
    const map = SourceMap.parse(json, mapUrl ?? url);
    if (typeof map === 'string') return map;
    return { lines: script.text.split('\n'), map };
  }

  /** Resolves a profiled function to its original name and position, or null if it can't be. */
  async resolve(frame: GeneratedFrame): Promise<ResolvedFrame | null> {
    if (!frame.url || !/^(https?|file|data):/.test(frame.url) || frame.line < 1) return null;
    const script = await this.load(frame.url);
    if (typeof script === 'string') return null;
    const line0 = frame.line - 1;
    const column0 = Math.max(0, frame.column - 1);
    const text = script.lines[line0] ?? '';
    const ident = generatedName(text, column0);
    const at = ident ? ident.column : column0;
    const original = script.map.originalPositionFor(line0, at);
    if (!original) return null;

    // The original name: from the map's names at the identifier, else read it from the source.
    let name: string | undefined;
    if (ident) {
      const seg = script.map.segments(line0).find((s) => s.column === ident.column && s.name !== undefined);
      if (seg) name = script.map.names[seg.name!];
      if (!name) {
        const sourceIndex = script.map.sources.indexOf(original.source);
        const content = sourceIndex >= 0 ? script.map.sourcesContent[sourceIndex] : null;
        const originalLine = content?.split('\n')[original.line];
        const m = originalLine ? /^[\w$]+/.exec(originalLine.slice(original.column)) : null;
        if (m && !RESERVED.has(m[0])) name = m[0];
      }
    }
    return {
      ...(name ? { name } : {}),
      source: original.source,
      line: original.line + 1,
      column: original.column + 1,
    };
  }
}
