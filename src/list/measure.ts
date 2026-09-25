import type { Browser, Locator, Page } from '@playwright/test';
import type { ListOptions, ListResult } from '../types.js';
import { analyzeFrames } from './analyze.js';
import { blankColors, listGeometry, referenceShot, type ListGeometry } from './probe.js';
import { summarizeList } from './summarize.js';

/** What the runner needs from a list: prepare each run, then analyse its screenshots. */
export interface ListMeasurement {
  prepare(): Promise<ListPrepared | { unavailable: string }>;
  /** The run's summary, plus each frame's drawn share relative to the list at rest (for replays). */
  analyze(
    prepared: ListPrepared,
    jpegs: string[],
  ): Promise<{ result: ListResult; drawn: number[] } | { unavailable: string }>;
}

export interface ListPrepared {
  geometry: ListGeometry;
  blank: [number, number, number][];
  referencePng: Buffer;
  notes: string[];
}

/** Below this, the list at rest has too little content to judge blank frames against. */
const MIN_REFERENCE_COVERAGE = 0.05;

export function listMeasurement(
  page: Page,
  browser: Browser,
  target: Locator,
  direction: 'vertical' | 'horizontal',
  options: Required<ListOptions>,
): ListMeasurement {
  return {
    async prepare() {
      try {
        const geometry = await listGeometry(target);
        if (geometry.rect.width < 1 || geometry.rect.height < 1)
          return { unavailable: 'the list has no visible area' };
        const { colors, notes } = await blankColors(target, options);
        const referencePng = await referenceShot(page, geometry);
        return { geometry, blank: colors, referencePng, notes };
      } catch (err) {
        return { unavailable: `the list couldn't be prepared: ${String(err).split('\n')[0]}` };
      }
    },
    async analyze(prepared, jpegs) {
      const a = await analyzeFrames(browser, {
        jpegs,
        referencePng: prepared.referencePng,
        geometry: prepared.geometry,
        direction,
        blank: prepared.blank,
      });
      if (a.frames.length === 0)
        return { unavailable: `none of the ${jpegs.length} screenshots could be decoded` };
      if (a.reference < MIN_REFERENCE_COVERAGE) {
        return {
          unavailable: `the list at rest is ${Math.round(a.reference * 100)}% drawn by this measure, too little to judge blank frames (is its content the same colour as its background?)`,
        };
      }
      return {
        result: summarizeList(a.frames, a.reference),
        drawn: a.frames.map((f) => Math.min(1, f / a.reference)),
      };
    },
  };
}
