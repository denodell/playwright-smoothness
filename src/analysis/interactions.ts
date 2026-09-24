import type { EventRecord, LoafRecord } from '../collector/collector.js';

/** One user interaction (a click, tap or key press), from Event Timing. */
export interface Interaction {
  id: number;
  /** What the interaction was, such as `click` or `keydown` (see EVENT_PRIORITY). */
  event: string;
  start: number;
  /** Input to next paint, ms. */
  duration: number;
  target: string;
  /** Where the target name came from. */
  targetSource: 'event-timing' | 'loaf-invoker' | 'unknown';
}

/**
 * An interaction is several events (pointerdown, pointerup, click; or keydown, keyup) that
 * often share one duration. It is named after the event that says what the user did.
 */
const EVENT_PRIORITY = ['click', 'keydown', 'keypress', 'keyup', 'pointerup', 'pointerdown', 'tap'];
function eventRank(name: string): number {
  const i = EVENT_PRIORITY.indexOf(name);
  return i < 0 ? EVENT_PRIORITY.length : i;
}

/** `BUTTON#vanish.onclick` → `button#vanish`. Returns null for invokers that aren't elements. */
export function elementFromInvoker(invoker: string): string | null {
  const m = /^([A-Z][A-Z0-9-]*)((?:[#.][^.#\s]+)*)\.on[a-z]+$/.exec(invoker);
  if (!m) return null;
  const tag = m[1]!.toLowerCase();
  if (tag === 'window' || tag === 'document' || tag === 'domwindow') return null;
  return tag + m[2]!;
}

/**
 * Groups Event Timing entries by interactionId and keeps the longest entry of each.
 * When the target was removed (Event Timing reports null), falls back to the invoker of an
 * event-listener script in a long frame overlapping the interaction.
 */
export function groupInteractions(events: EventRecord[], loaf: LoafRecord[]): Interaction[] {
  const longest = new Map<number, EventRecord>();
  const named = new Map<number, string>();
  const namedTarget = new Map<number, string>();
  for (const e of events) {
    if (!(e.interactionId > 0)) continue;
    const cur = longest.get(e.interactionId);
    if (!cur || e.duration > cur.duration) longest.set(e.interactionId, e);
    const name = named.get(e.interactionId);
    if (name === undefined || eventRank(e.name) < eventRank(name)) named.set(e.interactionId, e.name);
    // Any entry in the interaction that still had a target names it (pointerdown often does
    // when the click's target has since been removed).
    if (e.target && !namedTarget.has(e.interactionId)) namedTarget.set(e.interactionId, e.target);
  }
  const out: Interaction[] = [];
  for (const [id, e] of longest) {
    let target = e.target ?? namedTarget.get(id) ?? null;
    let targetSource: Interaction['targetSource'] = target ? 'event-timing' : 'unknown';
    if (!target) {
      const end = e.start + e.duration;
      for (const f of loaf) {
        if (f.start > end || f.start + f.duration < e.start) continue;
        for (const s of f.scripts) {
          const el = s.invokerType === 'event-listener' ? elementFromInvoker(s.invoker) : null;
          if (el) {
            target = el;
            targetSource = 'loaf-invoker';
            break;
          }
        }
        if (target) break;
      }
    }
    out.push({
      id,
      event: named.get(id) ?? e.name,
      start: e.start,
      duration: e.duration,
      target: target ?? 'unknown',
      targetSource,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}
