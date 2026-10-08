import { decodeSegment } from './vlq.js';

/** One mapping: a generated column mapped to an original position (all 0-based). */
export interface Segment {
  column: number;
  source?: number;
  line?: number;
  originalColumn?: number;
  name?: number;
}

export interface OriginalPosition {
  source: string;
  /** 0-based. */
  line: number;
  /** 0-based. */
  column: number;
  name?: string;
}

interface RawMap {
  version?: unknown;
  sources?: unknown;
  sourcesContent?: unknown;
  names?: unknown;
  mappings?: unknown;
  sourceRoot?: unknown;
  sections?: unknown;
}

/**
 * A parsed source map v3 (not index maps with `sections`). Lines are decoded lazily: a large
 * bundle's map can be several MB, and only a handful of positions are ever looked up.
 */
export class SourceMap {
  readonly sources: string[];
  readonly sourcesContent: (string | null)[];
  readonly names: string[];
  private readonly lineStarts: number[] = [];
  private readonly decoded = new Map<number, Segment[]>();
  /** Running values carried across lines, decoded up to `decodedThrough`. */
  private readonly state = { source: 0, line: 0, column: 0, name: 0 };
  private decodedThrough = -1;

  private constructor(
    private readonly mappings: string,
    sources: string[],
    sourcesContent: (string | null)[],
    names: string[],
  ) {
    this.sources = sources;
    this.sourcesContent = sourcesContent;
    this.names = names;
    let start = 0;
    for (;;) {
      this.lineStarts.push(start);
      const next = mappings.indexOf(';', start);
      if (next < 0) break;
      start = next + 1;
    }
  }

  /** Parses map JSON, or returns a reason it can't be used. */
  static parse(json: string, mapUrl?: string): SourceMap | string {
    let raw: RawMap;
    try {
      raw = JSON.parse(json.replace(/^\)\]\}'[^\n]*\n/, '')) as RawMap; // optional XSSI prefix
    } catch (err) {
      return `the source map isn't valid JSON (${String(err).slice(0, 80)})`;
    }
    if (raw.sections) return 'index source maps (with sections) are not supported';
    if (raw.version !== 3) return `source map version ${String(raw.version)} is not supported`;
    if (typeof raw.mappings !== 'string' || !Array.isArray(raw.sources))
      return 'the source map has no mappings or sources';
    const root = typeof raw.sourceRoot === 'string' ? raw.sourceRoot : '';
    const sources = (raw.sources as unknown[]).map((s) => resolveSource(String(s ?? ''), root, mapUrl));
    const content = Array.isArray(raw.sourcesContent)
      ? (raw.sourcesContent as unknown[]).map((c) => (typeof c === 'string' ? c : null))
      : [];
    const names = Array.isArray(raw.names) ? (raw.names as unknown[]).map((n) => String(n)) : [];
    return new SourceMap(raw.mappings, sources, content, names);
  }

  /** Segments on a generated line (0-based), in column order. */
  segments(line: number): Segment[] {
    if (line < 0 || line >= this.lineStarts.length) return [];
    // Source, original line/column and name indices are deltas carried across lines, so every
    // earlier line has to be decoded first (columns reset each line).
    while (this.decodedThrough < line) this.decodeLine(this.decodedThrough + 1);
    return this.decoded.get(line) ?? [];
  }

  private decodeLine(line: number): void {
    const start = this.lineStarts[line]!;
    const end = line + 1 < this.lineStarts.length ? this.lineStarts[line + 1]! - 1 : this.mappings.length;
    const out: Segment[] = [];
    let column = 0;
    let s = start;
    while (s < end) {
      let e = this.mappings.indexOf(',', s);
      if (e < 0 || e > end) e = end;
      const v = decodeSegment(this.mappings, s, e);
      if (v && v.length >= 1) {
        column += v[0]!;
        const seg: Segment = { column };
        if (v.length >= 4) {
          this.state.source += v[1]!;
          this.state.line += v[2]!;
          this.state.column += v[3]!;
          seg.source = this.state.source;
          seg.line = this.state.line;
          seg.originalColumn = this.state.column;
          if (v.length >= 5) {
            this.state.name += v[4]!;
            seg.name = this.state.name;
          }
        }
        out.push(seg);
      }
      s = e + 1;
    }
    out.sort((a, b) => a.column - b.column);
    this.decoded.set(line, out);
    this.decodedThrough = line;
  }

  /** The segment covering a generated position (the last one at or before the column). */
  private segmentAt(line: number, column: number): Segment | undefined {
    const segs = this.segments(line);
    let lo = 0;
    let hi = segs.length - 1;
    let found: Segment | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid]!.column <= column) {
        found = segs[mid];
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  }

  /** The original position of a generated one, or undefined when it isn't mapped. */
  originalPositionFor(line: number, column: number): OriginalPosition | undefined {
    const seg = this.segmentAt(line, column);
    if (!seg || seg.source === undefined) return undefined;
    return {
      source: this.sources[seg.source] ?? '',
      line: seg.line!,
      column: seg.originalColumn!,
      ...(seg.name !== undefined && this.names[seg.name] !== undefined ? { name: this.names[seg.name] } : {}),
    };
  }
}

function resolveSource(source: string, root: string, mapUrl?: string): string {
  const joined = root ? root.replace(/\/?$/, '/') + source : source;
  if (!mapUrl) return joined;
  try {
    return new URL(joined, mapUrl).href;
  } catch {
    return joined;
  }
}
