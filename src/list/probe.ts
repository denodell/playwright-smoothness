import type { Locator, Page } from '@playwright/test';
import type { ListOptions } from '../types.js';

/** The list's scrollable client area (no borders or scrollbars), in viewport CSS pixels. */
export interface ListGeometry {
  rect: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  scroll: { top: number; left: number; maxTop: number; maxLeft: number };
  /** True when the target is the page's own scroller (html or body). */
  document: boolean;
}

export async function listGeometry(target: Locator): Promise<ListGeometry> {
  return target.evaluate((el) => {
    const doc = el === document.scrollingElement || el === document.documentElement || el === document.body;
    const scroller = (doc ? (document.scrollingElement ?? document.documentElement) : el) as HTMLElement;
    const r = doc ? { left: 0, top: 0 } : el.getBoundingClientRect();
    return {
      rect: doc
        ? {
            x: 0,
            y: 0,
            width: document.documentElement.clientWidth,
            height: document.documentElement.clientHeight,
          }
        : {
            x: r.left + el.clientLeft,
            y: r.top + el.clientTop,
            width: el.clientWidth,
            height: el.clientHeight,
          },
      viewport: { width: innerWidth, height: innerHeight },
      scroll: {
        top: scroller.scrollTop,
        left: scroller.scrollLeft,
        maxTop: scroller.scrollHeight - scroller.clientHeight,
        maxLeft: scroller.scrollWidth - scroller.clientWidth,
      },
      document: doc,
    };
  });
}

/**
 * Resolves the colours that count as blank: the list's background (`'auto'` walks up to the
 * first ancestor with an opaque background) and each placeholder, which is a CSS colour or a
 * selector whose element's background is used. Anything unresolvable is reported, not guessed.
 */
export async function blankColors(
  target: Locator,
  list: Required<ListOptions>,
): Promise<{ colors: [number, number, number][]; notes: string[] }> {
  return target.evaluate(
    (el, opts) => {
      const notes: string[] = [];
      const ctx = new OffscreenCanvas(1, 1).getContext('2d')!;
      // Normalises any CSS colour via the canvas; returns null for invalid or mostly transparent ones.
      const parse = (c: string): [number, number, number] | null => {
        if (!CSS.supports('color', c)) return null;
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = c;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return d[3]! >= 128 ? [d[0]!, d[1]!, d[2]!] : null;
      };
      const colors: [number, number, number][] = [];
      if (opts.background === 'auto') {
        let node: Element | null = el;
        let found: [number, number, number] | null = null;
        while (node && !found) {
          found = parse(getComputedStyle(node).backgroundColor);
          node = node.parentElement;
        }
        if (!found)
          notes.push(
            "The list and its ancestors have no background colour, so white (the browser's default) is used.",
          );
        colors.push(found ?? [255, 255, 255]);
      } else {
        const c = parse(opts.background);
        if (!c) notes.push(`list.background '${opts.background}' isn't a CSS colour; white is used.`);
        colors.push(c ?? [255, 255, 255]);
      }
      for (const p of opts.placeholders) {
        const asColour = parse(p);
        if (asColour) {
          colors.push(asColour);
          continue;
        }
        let match: Element | null;
        try {
          match = document.querySelector(p);
        } catch {
          notes.push(`list.placeholders '${p}' is neither a colour nor a valid selector; ignored.`);
          continue;
        }
        const c = match ? parse(getComputedStyle(match).backgroundColor) : null;
        if (c) colors.push(c);
        else
          notes.push(
            `list.placeholders '${p}' matched no element with a background colour at the start of the run; ignored.`,
          );
      }
      return { colors, notes };
    },
    { background: list.background, placeholders: list.placeholders },
  );
}

/** The list's client area at rest, as a PNG at CSS-pixel scale. */
export async function referenceShot(page: Page, g: ListGeometry): Promise<Buffer> {
  const x = Math.max(0, g.rect.x);
  const y = Math.max(0, g.rect.y);
  const width = Math.min(g.rect.x + g.rect.width, g.viewport.width) - x;
  const height = Math.min(g.rect.y + g.rect.height, g.viewport.height) - y;
  return page.screenshot({ clip: { x, y, width, height }, type: 'png', scale: 'css' });
}
