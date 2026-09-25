import type { CpuProfile } from '../trace/parse.js';
import type { GeneratedFrame, ResolvedFrame } from '../sourcemap/resolve.js';
import type { HotFunction, ProfileResult } from '../types.js';
import { round1 } from './stats.js';

/** How many functions a result names. */
const HOT_FUNCTIONS = 5;
/** How many callers are kept for each hot function. */
const MAX_CALLERS = 8;

/** V8 pseudo-nodes that aren't work: the tree root and time the thread spent waiting. */
const NOT_WORK = new Set(['(root)', '(idle)']);

interface FunctionStats extends GeneratedFrame {
  selfMs: number;
  totalMs: number;
  /** Caller chains (function keys, nearest first, joined) and the self time seen under each. */
  callers: Map<string, number>;
}

/** Per-run totals, keyed by function identity. */
export type ProfileRun = { functions: Map<string, FunctionStats>; sampledMs: number };

const SEP = '\u0000';
const CHAIN_SEP = '\u0001';
export const frameKey = (n: GeneratedFrame) => [n.fn, n.url, n.line, n.column].join(SEP);

/**
 * Attributes the samples that fall inside `windows` (page ms) to functions. Self time goes to
 * the sampled function; total time to it and every caller (each once per sample, so recursion
 * isn't double-counted).
 */
export function attributeProfile(profile: CpuProfile, windows: [number, number][]): ProfileRun {
  const functions = new Map<string, FunctionStats>();
  let sampledMs = 0;
  const inWindow = (t: number) => windows.some(([a, b]) => t >= a && t <= b);
  for (const s of profile.samples) {
    if (!inWindow(s.t)) continue;
    const leaf = profile.nodes.get(s.node);
    if (!leaf || NOT_WORK.has(leaf.fn)) continue;
    sampledMs += s.ms;
    const chain: string[] = [];
    const seen = new Set<string>();
    for (let id: number | undefined = s.node; id !== undefined;) {
      const n = profile.nodes.get(id);
      if (!n) break;
      if (!NOT_WORK.has(n.fn)) {
        const k = frameKey(n);
        let f = functions.get(k);
        if (!f) {
          f = {
            fn: n.fn,
            url: n.url,
            line: n.line,
            column: n.column,
            selfMs: 0,
            totalMs: 0,
            callers: new Map(),
          };
          functions.set(k, f);
        }
        if (!seen.has(k)) {
          f.totalMs += s.ms;
          seen.add(k);
        }
        chain.push(k);
      }
      id = n.parent;
    }
    const self = functions.get(chain[0]!)!;
    self.selfMs += s.ms;
    const callers = chain.slice(1, MAX_CALLERS + 1).join(CHAIN_SEP);
    self.callers.set(callers, (self.callers.get(callers) ?? 0) + s.ms);
  }
  return { functions, sampledMs };
}

interface Ranked extends FunctionStats {
  /** The most common caller chain, as function keys. */
  chain: string[];
}

function rank(runs: ProfileRun[]): Ranked[] {
  const all = new Map<string, FunctionStats>();
  for (const run of runs) {
    for (const [k, f] of run.functions) {
      const cur = all.get(k);
      if (!cur) {
        all.set(k, { ...f, callers: new Map(f.callers) });
        continue;
      }
      cur.selfMs += f.selfMs;
      cur.totalMs += f.totalMs;
      for (const [c, ms] of f.callers) cur.callers.set(c, (cur.callers.get(c) ?? 0) + ms);
    }
  }
  return [...all.values()]
    .filter((f) => f.selfMs > 0)
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, HOT_FUNCTIONS)
    .map((f) => {
      const [top] = [...f.callers.entries()].sort((a, b) => b[1] - a[1])[0] ?? [''];
      return { ...f, chain: top ? top.split(CHAIN_SEP) : [] };
    });
}

function parseKey(k: string): GeneratedFrame {
  const [fn, url, line, column] = k.split(SEP);
  return { fn: fn!, url: url!, line: Number(line), column: Number(column) };
}

/** Every function a result will name: the hot functions and their callers. For name resolution. */
export function namedFrames(runs: ProfileRun[]): GeneratedFrame[] {
  const keys = new Set<string>();
  for (const f of rank(runs)) {
    keys.add(frameKey(f));
    for (const c of f.chain) keys.add(c);
  }
  return [...keys].map(parseKey);
}

/**
 * Averages runs and keeps the functions with the most self time. With `resolved` (from source
 * maps, keyed by frameKey), names and positions are the original ones and the bundle position
 * is kept as `generated`.
 */
export function combineProfiles(
  runs: ProfileRun[],
  resolved: Map<string, ResolvedFrame> = new Map(),
): ProfileResult {
  const n = Math.max(1, runs.length);
  const nameOf = (k: string) => resolved.get(k)?.name ?? parseKey(k).fn;
  const hotFunctions: HotFunction[] = rank(runs).map((f) => {
    const r = resolved.get(frameKey(f));
    const base = {
      selfMs: round1(f.selfMs / n),
      totalMs: round1(f.totalMs / n),
      callers: f.chain.map(nameOf),
    };
    if (!r) return { fn: f.fn, url: f.url, line: f.line, column: f.column, ...base };
    return {
      fn: r.name ?? f.fn,
      url: r.source,
      line: r.line,
      column: r.column,
      ...base,
      generated: { fn: f.fn, url: f.url, line: f.line, column: f.column },
    };
  });
  return { hotFunctions, sampledMs: round1(runs.reduce((a, r) => a + r.sampledMs, 0) / n) };
}
