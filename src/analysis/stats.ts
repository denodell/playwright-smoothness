import type { Spread } from '../types.js';

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Nearest-rank percentile (p in 0..100). With few samples, p95 is the largest value. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(s.length, Math.max(1, rank)) - 1]!;
}

export function spread(values: number[]): Spread {
  return { min: Math.min(...values), median: median(values), max: Math.max(...values) };
}

/** Rounds to one decimal place, for stable JSON. */
export function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
