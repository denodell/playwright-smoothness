// Trace categories, chosen by measuring what each contributes (docs/trace-categories.md).
// Tracing the same ten-scroll interaction: the spike's set 2,148KB; FRAME_CATEGORIES 240KB;
// with ANIMATION_FRAME_CATEGORIES 368KB.

/**
 * PipelineReporter (frame states) is in `cc,benchmark,disabled-by-default-devtools.timeline.frame`;
 * the last is by far the smallest of the three. `blink.user_timing` carries the page's
 * performance.mark() calls, which window the trace to the measurement.
 */
export const FRAME_CATEGORIES = ['disabled-by-default-devtools.timeline.frame', 'blink.user_timing'];

/** AnimationFrame events (every main-thread frame's duration), for the 120Hz prediction only. */
export const ANIMATION_FRAME_CATEGORIES = ['devtools.timeline'];

/** Screenshot events, for blank-row detection in lists (M4). */
export const SCREENSHOT_CATEGORIES = ['disabled-by-default-devtools.screenshot'];
