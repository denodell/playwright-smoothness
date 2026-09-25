# Blank rows in lists

Virtualized lists fail by going blank: rows aren't built in time, so the user flings into empty space. Dropped frames miss this. In the costly test list, frames were 97% on time while 91% of frames were blank. `smoothness.scroll()` in full mode measures it directly from the trace's screenshots.

![A drawn list frame next to a blank one](hero.png)

## How it works

For each measured run:

1. **After the page settles, before tracing**, the library reads the list's client area (its box without borders or scrollbars, so a scrollbar can't count as content), resolves the colours that count as blank, and screenshots the list at rest as the **reference**.
2. **The gesture is traced with screenshots.** Chrome records one JPEG per frame the compositor produces, about 200 for a 3.3-second fling, at a reduced size (500×500 for a 600×600 viewport; the scale is worked out per image).
3. **After tracing**, each screenshot is cropped to the list and measured, and so is the reference.
4. A frame is **blank** when it's drawn to less than half of the reference (`BLANK_FRAME_SHARE`).

### What "drawn" means

A drawn list is still mostly background: padding, gaps, and each row's own fill. So counting background pixels says little. Instead the library counts **lines**: pixel rows for vertical scrolling, pixel columns for horizontal. A line has content when at least 1% of its pixels (and at least 2) differ from every blank colour by more than 24 per channel. The tolerance absorbs JPEG noise.

A drawn row of the test list has content on 70 of its 80 lines: its 70px poster. So a fully drawn test list measures 87.5%, which matches the spike's "at least 87% drawn". Comparing each frame with the list's own reference means sparse layouts aren't penalised for their whitespace.

### Blank colours

- `list.background: 'auto'` (the default) uses the list's computed background, walking up to the first ancestor with an opaque one, or white if there's none (with a note). It can also be any CSS colour.
- `list.placeholders` adds colours that count as blank: CSS colours, or selectors whose element's background is used, such as skeleton rows. A selector that matches nothing at the start of a run is ignored, with a note.

### Why decode in the browser

Trace screenshots are JPEGs. The options were a JPEG decoder in Node (a dependency such as `jpeg-js`, a pure-JavaScript decoder), or the browser that's already running. The library decodes in a **throwaway page of the same Chromium**, with `createImageBitmap` and `OffscreenCanvas`, after tracing has stopped:

- no dependency;
- Chrome's native decoder: 200 frames decode and measure in about 0.5s locally, well inside the brief's 2-second budget (asserted in `tests/integration/list.spec.ts`);
- the throwaway page is in its own browser context, so it can't affect the page being measured.

The line-counting function (`src/list/coverage.ts`) is plain code with no dependencies. It runs in that page, and unit tests call it directly in Node.

## Results

The test list (`test-pages/list.html`), 600×600, flung 20,000px at 6,000px/s with the mouse wheel, no CPU throttling, median of 3 runs. Locally, Chrome 153:

| List                                                               | Frames on time | Dropped | **Blank frames** | Least drawn |
| ------------------------------------------------------------------ | -------------- | ------- | ---------------- | ----------- |
| Cheap (0ms per row, overscan 2)                                    | 100%           | 0       | **0%**           | 100%        |
| Moderate (4ms per row, overscan 2)                                 | 100%           | 0       | **0%**           | 100%        |
| Costly (15ms per row, no overscan)                                 | 97.2%          | 6       | **90.7%**        | 0%          |
| Costly, dark background (`#202020`)                                | –              | –       | **> 50%**        | –           |
| Horizontal, cheap / costly                                         | –              | –       | **0% / 92.2%**   | 100% / 0%   |
| Skeleton rows (grey for 250ms), not named / named as a placeholder | –              | –       | **0% / 97.5%**   | 89.6% / 0%  |

The spike's costly list was blank in 188 of 203 frames (93%). The moderate list dipped to 72% drawn in the spike, which ran in a single-CPU sandbox; on these machines the 4ms rows keep up.

## Limitations

- **Full mode only.** Quick mode has no screenshots; `scroll()` in quick mode reports long frames and input, and notes that blank rows need full mode.
- **The list must be visible**, and the reference must have some content: a list drawn in its own background colour can't be judged, and is reported as unavailable.
- **Screenshots are of the viewport.** Parts of the list outside the viewport aren't measured.
- **Touch needs a touch-enabled context.** On Linux, Chrome ignores a synthetic touch gesture unless the context has `hasTouch: true` (macOS doesn't), so `input: 'touch'` checks `navigator.maxTouchPoints` and throws if it's 0.
- **A list that doesn't move isn't measured.** If no run scrolled it, `list` is null and listed in `unavailable`: 0% blank would describe a list that stood still.
- **`distance: 'end'`** means the real end. The test list's end is 399,400px away (over a minute at 6,000px/s), so tests on long or infinite lists should pass a pixel distance.
- **`input: 'keys'`** presses arrow keys 100ms apart, at most 100 presses per run. Presses faster than 16ms aren't reported by Event Timing (its minimum threshold), so `input.interactions` counts the slow ones; `scroll.keyPresses` says how many there were.
