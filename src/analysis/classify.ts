import type { LoafRecord, ScrollRecord } from '../collector/collector.js';
import type { Interaction } from './interactions.js';

export type FrameClass = 'interaction' | 'load' | 'background';

/**
 * Frames starting before loadEventEnd plus this grace period are load frames. From the spike,
 * where this rule classified load frames correctly in every run.
 */
export const LOAD_GRACE_MS = 50;

/**
 * A scroll event recorded this many ms before a frame starts still belongs to that frame:
 * the listener runs at the start of the frame that handles the scroll.
 */
export const SCROLL_LEAD_MS = 5;

export interface ClassifyInput {
  loaf: LoafRecord[];
  interactions: Interaction[];
  scrolls: ScrollRecord[];
  loadEventEnd: number;
}

/**
 * Classifies each long frame without labels from the test, in this order:
 * 1. `firstUIEventTimestamp > 0`: the frame handled input.
 * 2. It overlaps an Event Timing interaction window.
 * 3. A scroll event fired during it.
 * 4. It started before load finished (plus LOAD_GRACE_MS).
 * 5. An `event-listener` script ran in it (a secondary signal: input the other rules missed).
 * 6. Otherwise, background.
 */
export function classifyFrame(f: LoafRecord, input: Omit<ClassifyInput, 'loaf'>): FrameClass {
  const end = f.start + f.duration;
  if (f.firstUIEventTimestamp > 0) return 'interaction';
  if (input.interactions.some((i) => f.start < i.start + i.duration && end > i.start)) return 'interaction';
  if (input.scrolls.some((s) => s.t >= f.start - SCROLL_LEAD_MS && s.t <= end)) return 'interaction';
  if (input.loadEventEnd > 0 && f.start < input.loadEventEnd + LOAD_GRACE_MS) return 'load';
  if (input.loadEventEnd === 0) return 'load'; // the page hasn't finished loading yet
  if (
    f.scripts.some(
      (s) =>
        s.invokerType === 'event-listener' &&
        /\.on(pointer|mouse|key|click|touch|wheel|scroll|input)/.test(s.invoker),
    )
  ) {
    return 'interaction';
  }
  return 'background';
}

export function classifyFrames(input: ClassifyInput): FrameClass[] {
  return input.loaf.map((f) => classifyFrame(f, input));
}
