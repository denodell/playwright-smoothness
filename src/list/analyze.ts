import type { Browser } from '@playwright/test';
import { lineCoverage, type CoverageOptions } from './coverage.js';
import type { ListGeometry } from './probe.js';

/** Largest per-channel difference that still matches a blank colour (trace JPEGs are lossy). */
const COLOR_TOLERANCE = 24;
/** A line has content when at least 1% of its pixels (and at least 2) aren't blank. */
const MIN_CONTENT_SHARE = 0.01;

export interface ListAnalysis {
  /** Drawn share of each frame, 0..1. */
  frames: number[];
  /** Drawn share of the list at rest. */
  reference: number;
  /** Frames that couldn't be decoded. */
  failed: number;
}

/**
 * Decodes and measures frames in a throwaway page of the same Chromium, after the measurement,
 * so it can't affect the numbers. Chosen over a JPEG decoder in Node because it adds no
 * dependency and uses the browser's own (fast, native) decoder; see docs/list-detection.md.
 */
export async function analyzeFrames(
  browser: Browser,
  input: {
    jpegs: string[];
    referencePng: Buffer;
    geometry: ListGeometry;
    direction: CoverageOptions['direction'];
    blank: [number, number, number][];
  },
): Promise<ListAnalysis> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    return await page.evaluate(
      async ({ jpegs, png, rect, viewport, options, source }) => {
        const coverage = new Function(`return (${source})`)() as (
          d: Uint8ClampedArray,
          w: number,
          h: number,
          o: typeof options,
        ) => number;
        const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const measure = async (b64: string, type: string, crop: boolean) => {
          const bmp = await createImageBitmap(new Blob([bytes(b64)], { type }));
          const sx = crop ? bmp.width / viewport.width : 1;
          const sy = crop ? bmp.height / viewport.height : 1;
          const x = crop ? Math.max(0, Math.round(rect.x * sx)) : 0;
          const y = crop ? Math.max(0, Math.round(rect.y * sy)) : 0;
          const w = crop ? Math.min(bmp.width - x, Math.round(rect.width * sx)) : bmp.width;
          const h = crop ? Math.min(bmp.height - y, Math.round(rect.height * sy)) : bmp.height;
          if (w <= 0 || h <= 0) return 0;
          const canvas = new OffscreenCanvas(w, h);
          const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
          ctx.drawImage(bmp, x, y, w, h, 0, 0, w, h);
          bmp.close();
          return coverage(ctx.getImageData(0, 0, w, h).data, w, h, options);
        };
        const reference = await measure(png, 'image/png', false);
        let failed = 0;
        const frames = (
          await Promise.all(
            jpegs.map((j) =>
              measure(j, 'image/jpeg', true).catch(() => {
                failed++;
                return null;
              }),
            ),
          )
        ).filter((f): f is number => f !== null);
        return { frames, reference, failed };
      },
      {
        jpegs: input.jpegs,
        png: input.referencePng.toString('base64'),
        rect: input.geometry.rect,
        viewport: input.geometry.viewport,
        options: {
          direction: input.direction,
          blank: input.blank,
          tolerance: COLOR_TOLERANCE,
          minContentShare: MIN_CONTENT_SHARE,
        },
        source: lineCoverage.toString(),
      },
    );
  } finally {
    await context.close();
  }
}
