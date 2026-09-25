import type { CDPSession, Locator, Page } from '@playwright/test';
import { listGeometry, type ListGeometry } from './list/probe.js';

/** Named speeds, in pixels per second. */
export const SPEEDS = { slow: 1500, normal: 3000, fast: 6000 } as const;

/** Time between arrow-key presses with `input: 'keys'`: slow enough for each to paint. */
const KEY_INTERVAL_MS = 100;
/** Most arrow-key presses one run makes; `distance: 'end'` with keys can otherwise take minutes. */
export const MAX_KEY_PRESSES = 100;
/** Chrome scrolls about 40px per arrow key; used to turn a pixel distance into presses. */
export const PX_PER_ARROW_KEY = 40;
/** The scroll has ended when the position is unchanged for this many polls in a row (a fling coasts). */
const REST_POLLS = 5;
/** How often to check whether a fling has come to rest. About two frames at 60Hz. */
const REST_POLL_MS = 32;
/** Longest to wait for a fling to come to rest after the gesture. */
const REST_TIMEOUT_MS = 3_000;

export interface ScrollOptions {
  /** `'end'` (default) scrolls to the end of the list; a number scrolls that many pixels. */
  distance?: 'end' | number;
  /** Default `'vertical'`. */
  direction?: 'vertical' | 'horizontal';
  /** `'wheel'` (default) and `'touch'` use a compositor-driven gesture; `'keys'` presses arrow keys. */
  input?: 'wheel' | 'touch' | 'keys';
  /** `'slow'` (1,500px/s), `'normal'` (3,000px/s, default), `'fast'` (6,000px/s), or pixels per second. Ignored for keys. */
  speed?: keyof typeof SPEEDS | number;
  /** Names the baseline. Default: built from the locator and these options. */
  label?: string;
}

export interface ResolvedScroll {
  distance: 'end' | number;
  direction: 'vertical' | 'horizontal';
  input: 'wheel' | 'touch' | 'keys';
  speedPxPerSec: number;
}

export function resolveScroll(o: ScrollOptions): ResolvedScroll {
  const speed = o.speed ?? 'normal';
  const speedPxPerSec = typeof speed === 'number' ? speed : SPEEDS[speed];
  if (!(speedPxPerSec > 0))
    throw new Error(
      `smoothness.scroll(): speed must be slow, normal, fast or a positive number, got ${String(speed)}.`,
    );
  const distance = o.distance ?? 'end';
  if (distance !== 'end' && !(typeof distance === 'number' && distance > 0)) {
    throw new Error(
      `smoothness.scroll(): distance must be 'end' or a positive number of pixels, got ${String(distance)}.`,
    );
  }
  return { distance, direction: o.direction ?? 'vertical', input: o.input ?? 'wheel', speedPxPerSec };
}

/** `scroll getByRole('list', { name: 'Trending' })`, plus any options that differ from the defaults. */
export function defaultScrollLabel(target: Locator, s: ResolvedScroll): string {
  const parts = [`scroll ${String(target)}`];
  if (s.direction !== 'vertical') parts.push(s.direction);
  if (s.input !== 'wheel') parts.push(s.input);
  if (s.input !== 'keys' && s.speedPxPerSec !== SPEEDS.normal) parts.push(`${s.speedPxPerSec}px/s`);
  if (s.distance !== 'end') parts.push(`${s.distance}px`);
  return parts.join(' ');
}

const position = (g: ListGeometry, s: ResolvedScroll) =>
  s.direction === 'vertical' ? g.scroll.top : g.scroll.left;
const maximum = (g: ListGeometry, s: ResolvedScroll) =>
  s.direction === 'vertical' ? g.scroll.maxTop : g.scroll.maxLeft;

/**
 * Waits until the scroll position stops changing. Polls on a timer, not requestAnimationFrame:
 * rAF callbacks can stall while a synthetic gesture is still being delivered, and this wait
 * must always end by REST_TIMEOUT_MS.
 */
async function waitForRest(target: Locator, s: ResolvedScroll): Promise<number> {
  const began = Date.now();
  let last = position(await listGeometry(target), s);
  let still = 0;
  while (still < REST_POLLS && Date.now() - began < REST_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, REST_POLL_MS));
    const now = position(await listGeometry(target), s);
    still = now === last ? still + 1 : 0;
    last = now;
  }
  return last;
}

/** A flick drags across this share of the list, from one side towards the other. */
const FLICK_SPAN = 0.6;
/** Time between touch moves: one frame at 60Hz, so every frame sees the finger move. */
const TOUCH_MOVE_MS = 16;
/**
 * Pause between flicks, so each fling coasts before the next touch stops it. A flick coasted
 * about 1,000px in 750ms on the test list; touching again after 50ms cut that to 400px.
 */
const FLICK_GAP_MS = 300;
/** Most flicks per run; with a huge `distance`, the run stops here and says so. */
const MAX_FLICKS = 200;

/**
 * Touch scrolling as a user does it: press, drag across the list at the requested speed,
 * release (the list flings on), and repeat until the distance is covered. Sent as real touch
 * events (Input.dispatchTouchEvent). Input.synthesizeScrollGesture with a touch source does
 * nothing on Linux, with no error (docs/measurements.md).
 */
async function flick(
  page: Page,
  cdp: CDPSession,
  target: Locator,
  s: ResolvedScroll,
  box: { x0: number; y0: number; x1: number; y1: number },
  start: number,
  requested: number,
): Promise<void> {
  const vertical = s.direction === 'vertical';
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  const span = FLICK_SPAN * (vertical ? box.y1 - box.y0 : box.x1 - box.x0);
  const point = (offset: number) => [
    {
      x: Math.round(vertical ? cx : cx + span / 2 - offset),
      y: Math.round(vertical ? cy + span / 2 - offset : cy),
    },
  ];
  for (let i = 0; i < MAX_FLICKS; i++) {
    if (position(await listGeometry(target), s) - start >= requested) return;
    // https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchTouchEvent
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(0) });
    // Paced against the clock, not by fixed sleeps: each CDP round trip takes time too, and
    // sleeping 16ms on top of it made a 6,000px/s drag move at about 2,000px/s.
    const began = Date.now();
    for (let moved = 0, step = 1; moved < span; step++) {
      const wait = began + step * TOUCH_MOVE_MS - Date.now();
      if (wait > 0) await page.waitForTimeout(wait);
      moved = Math.min(span, ((Date.now() - began) / 1000) * s.speedPxPerSec);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(moved) });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(FLICK_GAP_MS);
  }
}

/**
 * Scrolls the target once. Returns the pixels requested and actually scrolled (a fling can
 * overshoot a pixel distance; the end of the list stops it short).
 */
export async function performScroll(
  page: Page,
  cdp: CDPSession,
  target: Locator,
  s: ResolvedScroll,
): Promise<{ requested: number; scrolled: number; presses?: number }> {
  await target.scrollIntoViewIfNeeded();
  const g = await listGeometry(target);
  const start = position(g, s);
  const remaining = maximum(g, s) - start;
  const requested = s.distance === 'end' ? remaining : s.distance;
  if (requested <= 0) return { requested: 0, scrolled: 0 };

  let presses = 0;
  if (s.input === 'keys') {
    const key = s.direction === 'vertical' ? 'ArrowDown' : 'ArrowRight';
    await target.focus().catch(() => undefined);
    const focused = await target.evaluate(
      (el) => el === document.activeElement || el.contains(document.activeElement),
    );
    if (!focused && !g.document) {
      // Not focusable: click just inside its top-left corner so Chrome scrolls it with the keys.
      await page.mouse.click(g.rect.x + 2, g.rect.y + 2);
    }
    presses = Math.min(MAX_KEY_PRESSES, Math.ceil(requested / PX_PER_ARROW_KEY));
    for (let i = 0; i < presses; i++) {
      await page.keyboard.press(key);
      await page.waitForTimeout(KEY_INTERVAL_MS);
    }
  } else {
    // The visible part of the list, in viewport coordinates.
    const box = {
      x0: Math.max(0, g.rect.x),
      y0: Math.max(0, g.rect.y),
      x1: Math.min(g.viewport.width, g.rect.x + g.rect.width),
      y1: Math.min(g.viewport.height, g.rect.y + g.rect.height),
    };
    if (s.input === 'touch') {
      await flick(page, cdp, target, s, box, start, requested);
    } else {
      // https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-synthesizeScrollGesture
      // Negative distances move the content up (or left): scrolling towards the end. The call
      // returns when the gesture has finished.
      await cdp.send('Input.synthesizeScrollGesture', {
        x: Math.round((box.x0 + box.x1) / 2),
        y: Math.round((box.y0 + box.y1) / 2),
        ...(s.direction === 'vertical' ? { yDistance: -requested } : { xDistance: -requested }),
        speed: s.speedPxPerSec,
        gestureSourceType: 'mouse',
        preventFling: false,
      });
    }
  }
  const end = await waitForRest(target, s);
  return {
    requested,
    scrolled: end - start,
    ...(presses ? { presses } : {}),
  };
}
