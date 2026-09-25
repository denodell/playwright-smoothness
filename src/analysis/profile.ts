import type { CpuProfile } from '../trace/parse.js';
import type { HotFunction, ProfileResult } from '../types.js';
import { round1 } from './stats.js';

/** How many functions a result names. */
export const HOT_FUNCTIONS = 5;
/** How many callers are kept for each hot function. */
export const MAX_CALLERS = 8;

/** V8 pseudo-nodes that aren't work: the tree root and time the thread spent waiting. */
const NOT_WORK = new Set(['(root)', '(idle)']);

interface FunctionStats {
  fn: string;
  url: string;
  line: number;
  column: number;
  selfMs: number;
  totalMs: number;
  /** Caller chains (joined names) and the self time seen under each. */
  callers: Map<string, number>;
}

/** Per-run totals, keyed by function identity. */
export type ProfileRun = { functions: Map<string, FunctionStats>; sampledMs: number };

const keyOf = (n: { fn: string; url: string; line: number; column: number }) =>
  `${n.fn}\u0000${n.url}\u0000${n.line}\u0000${n.column}`;

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
    const chain: FunctionStats[] = [];
    const seen = new Set<string>();
    for (let id: number | undefined = s.node; id !== undefined;) {
      const n = profile.nodes.get(id);
      if (!n) break;
      if (!NOT_WORK.has(n.fn)) {
        const k = keyOf(n);
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
        chain.push(f);
      }
      id = n.parent;
    }
    const self = chain[0]!;
    self.selfMs += s.ms;
    const callers = chain
      .slice(1, MAX_CALLERS + 1)
      .map((f) => f.fn)
      .join('\u0000');
    self.callers.set(callers, (self.callers.get(callers) ?? 0) + s.ms);
  }
  return { functions, sampledMs };
}

/** Averages runs and keeps the functions with the most self time. */
export function combineProfiles(runs: ProfileRun[]): ProfileResult {
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
  const n = Math.max(1, runs.length);
  const hotFunctions: HotFunction[] = [...all.values()]
    .filter((f) => f.selfMs > 0)
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, HOT_FUNCTIONS)
    .map((f) => {
      const [chain] = [...f.callers.entries()].sort((a, b) => b[1] - a[1])[0] ?? [''];
      return {
        fn: f.fn,
        url: f.url,
        line: f.line,
        column: f.column,
        selfMs: round1(f.selfMs / n),
        totalMs: round1(f.totalMs / n),
        callers: chain ? chain.split('\u0000') : [],
      };
    });
  return { hotFunctions, sampledMs: round1(runs.reduce((a, r) => a + r.sampledMs, 0) / n) };
}
