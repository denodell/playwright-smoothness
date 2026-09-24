import type { LoafRecord, ScrollRecord } from '../collector/collector.js';
import type { InputResult, LongFramesResult, TargetTiming, TopScript } from '../types.js';
import type { Interaction } from './interactions.js';
import { median, percentile, round1 } from './stats.js';

/** How many scripts to name in results and failure messages. */
export const TOP_SCRIPTS = 5;

export function summarizeInput(interactions: Interaction[]): InputResult {
  const durations = interactions.map((i) => i.duration);
  const byTarget = new Map<string, TargetTiming>();
  for (const i of interactions) {
    const cur = byTarget.get(i.target);
    if (!cur || i.duration > cur.ms)
      byTarget.set(i.target, { target: i.target, event: i.event, ms: i.duration });
  }
  return {
    interactions: interactions.length,
    p95ToPaintMs: durations.length ? percentile(durations, 95) : null,
    worstMs: durations.length ? Math.max(...durations) : null,
    byTarget: [...byTarget.values()].sort((a, b) => b.ms - a.ms),
  };
}

/** A long frame plus the interactions it served, as `click on button#x` labels. */
export type AttributedFrame = LoafRecord & { during?: string[] };

/**
 * Labels each frame with the interactions it overlapped (Event Timing) and the scroll targets
 * that fired during it. Framework-agnostic: it relies on timing, not on script names.
 */
export function attributeFrames(
  frames: LoafRecord[],
  interactions: Interaction[],
  scrolls: ScrollRecord[],
): AttributedFrame[] {
  return frames.map((f) => {
    const end = f.start + f.duration;
    const during = new Set<string>();
    for (const i of interactions) {
      if (f.start < i.start + i.duration && end > i.start) during.add(`${i.event} on ${i.target}`);
    }
    for (const s of scrolls) {
      if (s.t >= f.start - 5 && s.t <= end) during.add(`scroll on ${s.target ?? 'unknown'}`);
    }
    return { ...f, during: [...during] };
  });
}

/**
 * Each script's share of its frame's blocking time, split by script duration. LoAF gives
 * blocking per frame, not per script, so this is an attribution, not a direct measurement.
 */
export function scriptBlocking(frames: AttributedFrame[]): Map<string, TopScript> {
  const out = new Map<string, TopScript>();
  for (const f of frames) {
    const total = f.scripts.reduce((a, s) => a + s.duration, 0);
    for (const s of f.scripts) {
      const share = total > 0 ? (f.blockingDuration * s.duration) / total : 0;
      const key = [s.sourceURL, s.sourceFunctionName, s.invoker, s.invokerType].join('\u0000');
      const cur = out.get(key);
      if (cur) {
        cur.blockingMs += share;
        cur.durationMs += s.duration;
        for (const d of f.during ?? []) if (!cur.during.includes(d)) cur.during.push(d);
      } else
        out.set(key, {
          source: s.sourceURL,
          fn: s.sourceFunctionName,
          invoker: s.invoker,
          invokerType: s.invokerType,
          blockingMs: share,
          durationMs: s.duration,
          during: [...(f.during ?? [])],
        });
    }
  }
  return out;
}

export function summarizeLongFrames(frames: AttributedFrame[]): LongFramesResult {
  return {
    count: frames.length,
    totalBlockingMs: round1(frames.reduce((a, f) => a + f.blockingDuration, 0)),
    worstMs: frames.length ? round1(Math.max(...frames.map((f) => f.duration))) : null,
    topScripts: [...scriptBlocking(frames).values()]
      .sort((a, b) => b.blockingMs - a.blockingMs)
      .slice(0, TOP_SCRIPTS)
      .map((s) => ({ ...s, blockingMs: round1(s.blockingMs), durationMs: round1(s.durationMs) })),
  };
}

/** Median of each number across runs; nulls (nothing measured in that run) are skipped. */
export function medianOf(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null);
  return nums.length ? round1(median(nums)) : null;
}

export function combineInput(runs: InputResult[]): InputResult {
  const targets = new Map<string, { event: string; ms: number[] }>();
  for (const r of runs) {
    for (const t of r.byTarget) {
      const cur = targets.get(t.target) ?? { event: t.event, ms: [] };
      cur.ms.push(t.ms);
      targets.set(t.target, cur);
    }
  }
  return {
    interactions: Math.round(median(runs.map((r) => r.interactions))),
    p95ToPaintMs: medianOf(runs.map((r) => r.p95ToPaintMs)),
    worstMs: medianOf(runs.map((r) => r.worstMs)),
    byTarget: [...targets.entries()]
      .map(([target, v]) => ({ target, event: v.event, ms: round1(median(v.ms)) }))
      .sort((a, b) => b.ms - a.ms),
  };
}

export function combineLongFrames(
  runs: LongFramesResult[],
  perRunFrames: AttributedFrame[][],
): LongFramesResult {
  const all = scriptBlocking(perRunFrames.flat());
  return {
    count: Math.round(median(runs.map((r) => r.count))),
    totalBlockingMs: round1(median(runs.map((r) => r.totalBlockingMs))),
    worstMs: medianOf(runs.map((r) => r.worstMs)),
    topScripts: [...all.values()]
      .sort((a, b) => b.blockingMs - a.blockingMs)
      .slice(0, TOP_SCRIPTS)
      .map((s) => ({
        ...s,
        blockingMs: round1(s.blockingMs / runs.length),
        durationMs: round1(s.durationMs / runs.length),
      })),
  };
}
