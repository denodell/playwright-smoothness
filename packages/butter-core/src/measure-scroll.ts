import { median } from './analysis/stats.js';
import type { ElementTarget } from './driver.js';
import { listMeasurement } from './list/measure.js';
import { peekReplaySource } from './replay/source.js';
import { measure, type MeasureContext } from './runner.js';
import {
  END_CAP_PX,
  MAX_KEY_PRESSES,
  MIN_REMOVED_ROWS,
  PX_PER_ARROW_KEY,
  performScroll,
  restoreScroll,
  scrollPosition,
  type ResolvedScroll,
} from './scroll.js';
import type { SmoothnessResult } from './types.js';

/**
 * Scrolls a list (or the page) once as a warm-up and then `runs` more times, and measures it:
 * long frames and input in quick mode, plus dropped frames and blank rows from trace screenshots
 * in full mode. The result also says how far it scrolled and whether the list is virtualized.
 */
export async function measureScroll(
  ctx: MeasureContext,
  target: ElementTarget,
  s: ResolvedScroll,
): Promise<SmoothnessResult> {
  const { page } = ctx;
  const done: Awaited<ReturnType<typeof performScroll>>[] = [];
  const cdp = await page.cdp();
  try {
    let origin: number | null = null;
    // Where a run started instead of origin, when the page didn't stay where it was put.
    let strayed: number | null = null;
    // Chrome restores a document's scroll position on reload. A page that moves itself (a
    // smooth-scrolling script that sets the position every frame) takes that position as its own
    // and puts the page back after it's moved. With restoration off, each reload starts at the
    // top, before the page's scripts run. It's set on the current document too, because a reload
    // follows the setting of the document it leaves.
    if (ctx.options.reset !== 'none') {
      await page.addInitScript(manualScrollRestoration, undefined);
      await page.evaluate(manualScrollRestoration).catch(() => undefined);
    }
    const result = await measure(
      {
        ...ctx,
        ...(page.tracer() ? { list: listMeasurement(page, target, s.direction, ctx.options.list) } : {}),
        // Chrome restores a document's scroll position on reload, so without this each run
        // would start where the last one stopped. With reset: 'none', runs carry on instead.
        beforeRun: async (run) => {
          if (run === 0) origin = await scrollPosition(target, s);
          else if (ctx.options.reset !== 'none' && origin !== null) {
            await restoreScroll(target, s, origin);
            await page.evaluate(
              () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
            );
            const at = await scrollPosition(target, s);
            if (strayed === null && Math.abs(at - origin) > 1) strayed = at;
          }
        },
      },
      async () => {
        done.push(await performScroll(page, cdp, target, s));
      },
    );
    // The first scroll is the warm-up, and one after the measured runs is recorded for a replay.
    describeScroll(result, done.slice(1, 1 + ctx.options.runs), s, ctx);
    if (strayed !== null) {
      result.notes.push(
        `Runs didn't all start where the first did: one started at ${Math.round(strayed)}px instead of ${Math.round(origin ?? 0)}px, so they scrolled different parts of the list. Something on the page moved it after it was put back.`,
      );
    }
    return result;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** Adds how far the runs scrolled to the result, and what that means for its list numbers. */
function describeScroll(
  result: SmoothnessResult,
  measured: Awaited<ReturnType<typeof performScroll>>[],
  s: ResolvedScroll,
  ctx: MeasureContext,
): void {
  if (measured.length && measured.every((d) => d.requested > 0 && d.scrolled === 0)) {
    // Nothing moved: blank-frame numbers would describe a still list, so they're withheld.
    const reason = `the scroll gesture didn't move the list in any run (asked for ${measured[0]!.requested}px)`;
    if ('list' in result) result.list = null;
    result.unavailable.push({ measurement: 'list', reason });
    result.notes.push(`Nothing scrolled: ${reason}. Is the target the element that scrolls?`);
  }
  if (measured.length) {
    result.scroll = {
      input: s.input,
      direction: s.direction,
      speedPxPerSec: s.input === 'keys' ? null : s.speedPxPerSec,
      requestedPx: Math.round(median(measured.map((d) => d.requested))),
      scrolledPx: Math.round(median(measured.map((d) => d.scrolled))),
      ...(s.input === 'keys' ? { keyPresses: Math.round(median(measured.map((d) => d.presses ?? 0))) } : {}),
    };
    if (measured.every((d) => d.requested === 0)) {
      result.notes.push(
        "The list was already at its end, so nothing scrolled. With reset: 'none', later runs start where the last one stopped.",
      );
    }
    const toEnd = measured.find((d) => d.toEnd !== undefined)?.toEnd;
    if (toEnd !== undefined) {
      result.notes.push(
        `distance: 'end' stopped at ${END_CAP_PX.toLocaleString('en-US')}px; the end of the list was ${toEnd.toLocaleString('en-US')}px away. Pass a number of pixels to scroll further.`,
      );
    }
    if (s.input === 'keys' && measured.some((d) => d.requested > MAX_KEY_PRESSES * PX_PER_ARROW_KEY)) {
      result.notes.push(
        `Arrow keys were pressed at most ${MAX_KEY_PRESSES} times per run, which didn't reach the requested distance.`,
      );
    }
  }
  if (result.list) {
    // Blank frames mean rows that weren't built in time only on a virtualized list. On any
    // other page they'd mean empty space in the content, so they aren't gated there.
    const setting = ctx.options.list.virtualized;
    const virtualized = setting === 'auto' ? measured.some((d) => d.removed >= MIN_REMOVED_ROWS) : setting;
    result.list.virtualized = virtualized;
    const source = peekReplaySource(result);
    if (source) source.virtualized = virtualized;
    if (!virtualized) {
      result.notes.push(
        setting === 'auto'
          ? "The list doesn't appear to be virtualized (no rows were removed while it scrolled), so blank frames aren't gated: here they'd mean empty space in the content, not rows that weren't built in time. Set list: { virtualized: true } if it is."
          : "list.virtualized is false, so blank frames aren't gated.",
      );
    }
  }
}

function manualScrollRestoration(): void {
  try {
    history.scrollRestoration = 'manual';
  } catch {
    // a sandboxed or opaque document: nothing to change
  }
}
