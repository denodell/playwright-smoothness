// What the measuring engine needs from a browser automation library. Everything outside
// src/playwright/ (and the Playwright Test integration) talks to the browser only through these
// interfaces, so another library can drive the same engine with its own adapter. The engine is
// Chromium-only: it relies on the Chrome DevTools Protocol and Chrome's trace events.
import type { BrowserEnvironment } from './environment.js';
import type { FetchText } from './sourcemap/resolve.js';

/** A Chrome DevTools Protocol session attached to the page. */
export interface CdpSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CDP results are method-specific
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CDP event params are event-specific
  on(event: string, handler: (params: any) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as for on()
  off(event: string, handler: (params: any) => void): void;
  detach(): Promise<void>;
}

/** Runs a function in a page. Its argument and result must be JSON-serializable. */
export type Evaluate = <R, A = undefined>(fn: (arg: A) => R | Promise<R>, arg?: A) => Promise<R>;

/** Records a Chrome trace of the page. */
export interface Tracer {
  start(categories: string[], options: { screenshots: boolean }): Promise<void>;
  /** Stops tracing and returns the trace JSON (`{ traceEvents: [...] }`). */
  stop(): Promise<Buffer>;
}

/** A blank page of the same browser, for work that must not touch the page being measured. */
export interface ScratchPage {
  evaluate: Evaluate;
  close(): Promise<void>;
}

/** The page being measured. */
export interface PageDriver {
  /** The library's own page object, passed to a `reset` function. */
  readonly native: unknown;
  environment(): Promise<BrowserEnvironment>;
  evaluate: Evaluate;
  /** Runs `fn(arg)` in every document the page loads from now on, before the page's own scripts. */
  addInitScript<A>(fn: (arg: A) => unknown, arg: A): Promise<void>;
  /** Reloads and waits for the load event. */
  reload(): Promise<void>;
  /** The viewport in CSS pixels, when the library knows it. */
  viewport(): { width: number; height: number } | null;
  /** A PNG of a viewport region, at CSS-pixel scale. */
  screenshot(clip: { x: number; y: number; width: number; height: number }): Promise<Buffer>;
  /** A mouse click at viewport coordinates. */
  click(x: number, y: number): Promise<void>;
  /** Presses and releases a key, by its `KeyboardEvent.key` name (such as `ArrowDown`). */
  press(key: string): Promise<void>;
  cdp(): Promise<CdpSession>;
  /** Fetches a script or source map the way the page would (cookies and credentials apply). */
  fetchText: FetchText;
  /** Null when the page's browser can't be traced (full mode is then unavailable). */
  tracer(): Tracer | null;
  /**
   * Opens a scratch page. With `secure`, it's on an http://localhost origin, a secure context
   * (WebCodecs needs one). Null when the library can't open one for this page.
   */
  openScratchPage(options: { secure: boolean }): Promise<ScratchPage> | null;
}

/**
 * An element on the page, such as the list to scroll. Each method must find the element again
 * when it's called, not hold on to one found earlier: every run reloads the page, which replaces
 * the element. (A Playwright locator does this by itself; a Puppeteer element handle doesn't.)
 */
export interface ElementTarget {
  /** How the element is described in default labels, such as `getByRole('list')`. */
  readonly description: string;
  /** Runs `fn(element, arg)` in the page. */
  evaluate<R, A = undefined>(fn: (el: Element, arg: A) => R | Promise<R>, arg?: A): Promise<R>;
  scrollIntoView(): Promise<void>;
  focus(): Promise<void>;
}
