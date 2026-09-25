import type { ListResult } from '../types.js';

/**
 * A frame is blank when it's drawn to less than this share of the list at rest. The list at
 * rest is the reference, so sparse layouts (lots of whitespace between rows) aren't penalised.
 */
export const BLANK_FRAME_SHARE = 0.5;

/** Summarises one run: per-frame coverage against the at-rest reference. */
export function summarizeList(frames: number[], reference: number): ListResult {
  const relative = frames.map((f) => Math.min(1, f / reference));
  const blankFrames = relative.filter((r) => r < BLANK_FRAME_SHARE).length;
  const round1 = (x: number) => Math.round(x * 10) / 10;
  return {
    frames: frames.length,
    blankFrames,
    blankFramePercent: frames.length ? round1((100 * blankFrames) / frames.length) : 0,
    leastDrawnPercent: frames.length ? round1(100 * Math.min(...relative)) : 100,
  };
}
