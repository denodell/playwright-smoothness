// The in-page collector. Injected with page.addInitScript(installCollector, config), which
// serializes this function with toString(), so it must be completely self-contained: no
// imports, no references to anything outside its own body, and only syntax the target
// browser runs natively.
//
// Rules (brief principles 5 and 6):
// - Every observer callback and every per-entry operation has its own try/catch, because an
//   exception inside a callback silently drops the rest of that batch.
// - Records are plain numbers and strings. No DOM node survives a callback; targets are
//   described while the callback runs.
// - Errors are counted and kept (capped), so the Node side can report them as unavailable.

/** Property on window holding the collector. Unlikely to clash with page code. */
export const COLLECTOR_KEY = '__playwrightSmoothness';

export interface CollectorConfig {
  /** Event Timing threshold. 16 is the minimum the spec allows. */
  eventThresholdMs: number;
  /** Max records kept per buffer, so a long test can't grow memory without bound. */
  maxRecords: number;
  /** Selector for the nearest interactive ancestor, used to name event targets. */
  interactiveSelector: string;
  /**
   * Automatic mode: the name of a binding (context.exposeBinding) to stream every record to as
   * it arrives, so data survives navigation. Unset for measure() and scroll().
   */
  stream?: string;
}

/** One streamed batch: records from one document, identified by its timeOrigin. */
export interface StreamBatch {
  doc: number;
  url: string;
  loaf: LoafRecord[];
  events: EventRecord[];
  scrolls: ScrollRecord[];
  /** Set once the document has loaded. */
  loadEventEnd?: number;
  /** The latest raw input (pointerdown or keydown) in this batch, on the document's clock. */
  lastInput?: { at: number; type: string };
  errors: string[];
}

export interface LoafScriptRecord {
  invoker: string;
  invokerType: string;
  sourceURL: string;
  sourceFunctionName: string;
  sourceCharPosition: number;
  /** When the script started (page ms), or -1 if the browser didn't say. */
  start: number;
  duration: number;
}

export interface LoafRecord {
  start: number;
  duration: number;
  blockingDuration: number;
  firstUIEventTimestamp: number;
  scripts: LoafScriptRecord[];
}

export interface EventRecord {
  name: string;
  interactionId: number;
  start: number;
  processingStart: number;
  processingEnd: number;
  duration: number;
  /** Nearest interactive ancestor of the target, described at callback time. Null if the target was gone. */
  target: string | null;
  /** The element the event was actually dispatched to. */
  rawTarget: string | null;
}

export interface ScrollRecord {
  t: number;
  target: string | null;
}

export interface CollectorSnapshot {
  supported: { loaf: boolean; event: boolean };
  timeOrigin: number;
  loadEventEnd: number;
  loaf: LoafRecord[];
  events: EventRecord[];
  scrolls: ScrollRecord[];
  errors: string[];
  overflow: { loaf: number; events: number; scrolls: number };
}

export interface SettleOutcome {
  settled: boolean;
  waitedMs: number;
}

/** The collector's in-page API, reachable at window[COLLECTOR_KEY]. */
export interface CollectorApi {
  version: 1;
  now(): number;
  snapshot(from: number, to: number): CollectorSnapshot;
  settle(quietMs: number, timeoutMs: number): Promise<SettleOutcome>;
  flush(): Promise<void>;
}

export function installCollector(config: CollectorConfig): void {
  const KEY = '__playwrightSmoothness';
  const w = window as unknown as Record<string, unknown>;
  if (w[KEY]) return;

  const loaf: LoafRecord[] = [];
  const events: EventRecord[] = [];
  const scrolls: ScrollRecord[] = [];
  const errors: string[] = [];
  const overflow = { loaf: 0, events: 0, scrolls: 0 };
  let lastLongFrameEnd = 0;
  const supportedTypes = (() => {
    try {
      return PerformanceObserver.supportedEntryTypes || [];
    } catch {
      return [];
    }
  })();
  const supported = {
    loaf: supportedTypes.indexOf('long-animation-frame') >= 0,
    event: supportedTypes.indexOf('event') >= 0,
  };

  const fail = (where: string, err: unknown) => {
    try {
      if (errors.length < 50) {
        errors.push(where + ': ' + String(err));
        if (where !== 'stream' && config.stream) {
          const binding = (w as Record<string, unknown>)[config.stream];
          if (typeof binding === 'function') {
            (binding as (b: unknown) => unknown)({
              doc: performance.timeOrigin,
              url: location.href,
              loaf: [],
              events: [],
              scrolls: [],
              errors: [where + ': ' + String(err)],
            });
          }
        }
      }
    } catch {
      // nothing left to do
    }
  };

  const describe = (node: unknown): string | null => {
    try {
      const el = node as Element | null;
      if (!el || typeof el.tagName !== 'string') return null;
      let s = el.tagName.toLowerCase();
      if (el.id) return s + '#' + el.id;
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [];
      if (cls.length) s += '.' + cls.slice(0, 2).join('.');
      const label = el.getAttribute && el.getAttribute('aria-label');
      if (label) s += '[aria-label="' + label.slice(0, 40).replace(/"/g, "'") + '"]';
      return s;
    } catch (err) {
      fail('describe', err);
      return null;
    }
  };

  const interactiveAncestor = (node: unknown): Element | null => {
    try {
      const el = node as Element | null;
      if (!el || typeof el.closest !== 'function') return null;
      return el.closest(config.interactiveSelector) || el;
    } catch (err) {
      fail('ancestor', err);
      return null;
    }
  };

  // Streaming (automatic mode): records are batched per microtask and sent to the binding.
  let outbox: StreamBatch | null = null;
  const send = () => {
    const batch = outbox;
    outbox = null;
    if (!batch || !config.stream) return;
    try {
      const binding = (w as Record<string, unknown>)[config.stream];
      if (typeof binding === 'function') (binding as (b: StreamBatch) => unknown)(batch);
    } catch (err) {
      fail('stream', err);
    }
  };
  const stream = (kind: 'loaf' | 'events' | 'scrolls' | 'load' | 'input' | 'errors', record: unknown) => {
    if (!config.stream) return;
    try {
      if (!outbox) {
        outbox = {
          doc: performance.timeOrigin,
          url: location.href,
          loaf: [],
          events: [],
          scrolls: [],
          errors: [],
        };
        queueMicrotask(send);
      }
      if (kind === 'load') outbox.loadEventEnd = record as number;
      else if (kind === 'input') outbox.lastInput = record as StreamBatch['lastInput'];
      else (outbox[kind] as unknown[]).push(record);
    } catch (err) {
      fail('stream', err);
    }
  };

  const push = <T>(buffer: T[], record: T, kind: 'loaf' | 'events' | 'scrolls') => {
    if (buffer.length >= config.maxRecords) overflow[kind]++;
    else buffer.push(record);
    stream(kind, record);
  };

  if (supported.loaf) {
    try {
      new PerformanceObserver((list) => {
        let entries: PerformanceEntry[] = [];
        try {
          entries = list.getEntries();
        } catch (err) {
          fail('loaf getEntries', err);
        }
        for (const entry of entries) {
          try {
            const e = entry as unknown as Record<string, unknown> & { scripts?: Record<string, unknown>[] };
            const scripts: LoafScriptRecord[] = [];
            for (const s of e.scripts || []) {
              try {
                scripts.push({
                  invoker: String(s.invoker ?? ''),
                  invokerType: String(s.invokerType ?? ''),
                  sourceURL: String(s.sourceURL ?? ''),
                  sourceFunctionName: String(s.sourceFunctionName ?? ''),
                  sourceCharPosition: Number(s.sourceCharPosition ?? -1),
                  start: typeof s.startTime === 'number' ? s.startTime : -1,
                  duration: Number(s.duration ?? 0),
                });
              } catch (err) {
                fail('loaf script', err);
              }
            }
            const start = Number(e.startTime);
            const duration = Number(e.duration);
            push(
              loaf,
              {
                start,
                duration,
                blockingDuration: Number(e.blockingDuration ?? 0),
                firstUIEventTimestamp: Number(e.firstUIEventTimestamp ?? 0),
                scripts,
              },
              'loaf',
            );
            if (start + duration > lastLongFrameEnd) lastLongFrameEnd = start + duration;
          } catch (err) {
            fail('loaf entry', err);
          }
        }
      }).observe({ type: 'long-animation-frame', buffered: true });
    } catch (err) {
      fail('loaf observe', err);
      supported.loaf = false;
    }
  }

  if (supported.event) {
    try {
      new PerformanceObserver((list) => {
        let entries: PerformanceEntry[] = [];
        try {
          entries = list.getEntries();
        } catch (err) {
          fail('event getEntries', err);
        }
        for (const entry of entries) {
          try {
            const e = entry as PerformanceEventTiming;
            push(
              events,
              {
                name: e.name,
                interactionId: Number(e.interactionId ?? 0),
                start: e.startTime,
                processingStart: e.processingStart,
                processingEnd: e.processingEnd,
                duration: e.duration,
                target: describe(interactiveAncestor(e.target)),
                rawTarget: describe(e.target),
              },
              'events',
            );
          } catch (err) {
            fail('event entry', err);
          }
        }
      }).observe({
        type: 'event',
        buffered: true,
        durationThreshold: config.eventThresholdMs,
      } as PerformanceObserverInit);
    } catch (err) {
      fail('event observe', err);
      supported.event = false;
    }
  }

  try {
    addEventListener(
      'scroll',
      (event) => {
        try {
          const t = event.target;
          push(
            scrolls,
            {
              t: performance.now(),
              target: t === document || t === window ? 'document' : describe(t),
            },
            'scrolls',
          );
        } catch (err) {
          fail('scroll', err);
        }
      },
      { capture: true, passive: true },
    );
  } catch (err) {
    fail('scroll listen', err);
  }

  const loadEventEnd = () => {
    try {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      return nav ? nav.loadEventEnd : 0;
    } catch {
      return 0;
    }
  };

  if (config.stream) {
    // Raw inputs, streamed as they happen. The browser only measures an input once the next
    // frame paints, so an input the test navigates away from immediately is never measured;
    // knowing when it happened lets that be reported rather than silently missing.
    for (const type of ['pointerdown', 'keydown']) {
      try {
        addEventListener(
          type,
          (e) => {
            try {
              stream('input', { at: e.timeStamp, type: e.type });
            } catch {
              // never throw from the page
            }
          },
          { capture: true, passive: true },
        );
      } catch (err) {
        fail('input listen', err);
      }
    }
    try {
      addEventListener('load', () => {
        // loadEventEnd is set after load handlers finish.
        setTimeout(() => {
          try {
            stream('load', loadEventEnd());
          } catch (err) {
            fail('load', err);
          }
        }, 0);
      });
    } catch (err) {
      fail('load listen', err);
    }
  }

  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  const api: CollectorApi = {
    version: 1,
    now: () => performance.now(),
    snapshot(from, to) {
      const overlaps = (start: number, end: number) => start <= to && end >= from;
      return {
        supported: { loaf: supported.loaf, event: supported.event },
        timeOrigin: performance.timeOrigin,
        loadEventEnd: loadEventEnd(),
        loaf: loaf.filter((f) => overlaps(f.start, f.start + f.duration)),
        events: events.filter((e) => overlaps(e.start, e.start + e.duration)),
        scrolls: scrolls.filter((s) => s.t >= from && s.t <= to),
        errors: errors.slice(),
        overflow: { loaf: overflow.loaf, events: overflow.events, scrolls: overflow.scrolls },
      };
    },
    // Resolves once the page has loaded and no long frame has ended for quietMs.
    // A long frame blocks this timer too, so a frame in progress can't be missed.
    settle(quietMs, timeoutMs) {
      const began = performance.now();
      return new Promise((resolve) => {
        const check = () => {
          const now = performance.now();
          const loaded = document.readyState === 'complete' && loadEventEnd() > 0;
          const quietSince = Math.max(loadEventEnd(), lastLongFrameEnd);
          if (loaded && now - quietSince >= quietMs) resolve({ settled: true, waitedMs: now - began });
          else if (now - began >= timeoutMs) resolve({ settled: false, waitedMs: now - began });
          else setTimeout(check, 50);
        };
        check();
      });
    },
    // Event Timing and LoAF entries are delivered after the frame that ends the work.
    // Two frames and a task later, entries for everything before the call have arrived.
    async flush() {
      await nextFrame();
      await nextFrame();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };

  try {
    Object.defineProperty(w, KEY, { value: api, enumerable: false, configurable: false, writable: false });
  } catch (err) {
    fail('install', err);
  }
}
