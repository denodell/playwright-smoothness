# Recipes

Each recipe starts with the signs to look for in a fix brief, then the fix. Several can apply at once: a scroll handler can force layout and also run on every event. Fix the biggest cost first and measure again.

## Forced layout in a loop

**Signs:** `getBoundingClientRect`, `offsetHeight`, `offsetWidth`, `offsetTop`, `clientHeight`, `scrollTop` or `getComputedStyle` under "Browser APIs that used time", or inside a loop in a named function. Often alongside long frames.

Reading a size or position after changing a style makes the browser lay out the page there and then. Done once per item in a loop, with a write between each read, the page is laid out once per item.

**Fix:** do all the reads first, then all the writes. Better still, measure once and keep the numbers, and measure again only when something changes the layout (`ResizeObserver` for size changes, `IntersectionObserver` for visibility). If the reads only feed a style, a CSS rule may do the job with no reads at all.

```js
// Before: a read and a write per row
for (const row of rows) {
  row.style.minHeight = tallest + 'px';
  tallest = Math.max(tallest, row.offsetHeight);
}

// After: reads, then writes
const heights = rows.map((row) => row.offsetHeight);
const tallest = Math.max(...heights);
for (const row of rows) row.style.minHeight = tallest + 'px';
```

## Rebuilding everything on each input

**Signs:** a slow `input`, `keydown` or `click` under "Slowest interactions", and a handler that sets `innerHTML` on a container, re-renders a whole list, or builds DOM for every item. `innerHTML` or `appendChild` may appear under "Browser APIs that used time".

**Fix:** build the items once and update only what changed: toggle a class or the `hidden` attribute to filter, change the text of the items that changed, move nodes rather than recreating them. When a full rebuild can't be avoided, make the urgent part (the text in the box, the pressed state) paint first and do the rebuild after, with `startTransition` in React or by deferring the work past the next paint (see "One long task").

## Re-rendering every component

**Signs:** React, Vue or Angular code in the CPU profile, with a component's render function or an expensive helper (formatting, sorting, parsing) called from many components. In "Scripts in long frames" the invoker may be the framework's dispatcher rather than your handler.

**Fix:** stop components re-rendering when their props haven't changed, and stop repeating expensive work inside render.

- React: wrap list items in `memo`, compute expensive values with `useMemo`, and pass stable props: callbacks from `useCallback`, objects and arrays that aren't rebuilt on every render. Give list items stable `key`s from the data, not the index, so a sort moves items instead of re-rendering them.
- Vue: move expensive work into `computed` properties, and use `v-memo` for long lists.
- Angular: `ChangeDetectionStrategy.OnPush` on list items, pure pipes for formatting, and `track` (or `trackBy`) on `@for`/`*ngFor`.

```jsx
const Card = memo(function Card({ card }) {
  const summary = useMemo(() => formatDescription(card.description), [card.description]);
  return <CardBody card={card} summary={summary} />;
});
```

## Work on every scroll event

**Signs:** a `scroll` listener under "Scripts in long frames" or in the profile, frames on time down during a `scroll()` check, often with forced layout too.

Scroll events can fire more than once a frame, and each one runs the handler.

**Fix:**

1. Where CSS can do it, use CSS. Scroll-driven animations (`animation-timeline: scroll()` or `view()`) run parallax, progress bars and reveal effects on the compositor with no script at all. `position: sticky` replaces most scroll-position checks.
2. For visibility (lazy loading, reveal-on-scroll, analytics), use `IntersectionObserver` instead of measuring in the handler.
3. Otherwise, make the listener `{ passive: true }`, have it only note that a scroll happened, and do the work once in a `requestAnimationFrame` callback. Measure positions once up front, and move things with `transform` rather than `top` or `left`.

```js
const tops = imgs.map((img) => img.getBoundingClientRect().top + scrollY);
let queued = false;
addEventListener(
  'scroll',
  () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      imgs.forEach((img, i) => (img.style.transform = `translateY(${(tops[i] - scrollY) * 0.04}px)`));
    });
  },
  { passive: true },
);
```

## Taking over scrolling

**Signs:** a `wheel` or `touchmove` listener that calls `preventDefault()`, and a `requestAnimationFrame` loop that calls `scrollTo` or sets `scrollTop`. Frames on time down during a scroll, even when each frame's work looks small.

When the page scrolls itself from script, every frame of the scroll waits for the main thread. Native scrolling runs on the compositor and keeps going while script is busy.

**Fix:** remove the scripted scrolling and let the browser scroll. Use `scroll-behavior: smooth` for programmatic scrolls (anchor links, "back to top") and `scroll-snap` for snapping. Move whatever the loop also did per frame to the recipes above: `IntersectionObserver` for reveals, CSS scroll-driven animations for effects.

## Work inside every animation frame

**Signs:** a `requestAnimationFrame` callback in "Scripts in long frames" or the profile while something animates (a drawer, a modal, a carousel), and frames on time down. There may be no long frames at all: work of 20–40ms per frame drops frames without crossing 50ms.

**Fix:** do the work before the animation starts or after it ends, not on every frame. Build the content first, then animate. Animate `transform` and `opacity` with a CSS transition or the Web Animations API (`element.animate()`) rather than in a script loop, so the compositor runs the animation even if the main thread is busy. Avoid animating `width`, `height`, `top`, `left` or anything else that needs layout.

## Slow rows in a virtualized list

**Signs:** blank frames during a `scroll()` check, "The list is virtualized" on the List line, and the function that builds or renders a row in the profile.

**Fix:**

- Make a row cheaper to build: cache formatted text, dates and parsed content per item instead of recomputing them on every build, and keep rows shallow.
- Build a few rows past each edge of the viewport (overscan), so rows are ready before they scroll in. Most virtualization libraries have an option for this (`overscan`, `overscanCount`, `increaseViewportBy`).
- If a row has a slow part (a chart, rich text, an image), show the row's frame and text first and fill in the slow part after.

For a long list that isn't virtualized, `content-visibility: auto` with `contain-intrinsic-size` on each item skips the work for items off screen.

## A drag that redraws everything

**Signs:** a `pointermove` or `mousemove` handler in the scripts or profile during a drag, frames on time well down, often with forced layout from measuring other elements for snapping or drop targets.

**Fix:** measure what the drag needs once, on `pointerdown` (other elements' edges, drop zones). During the drag, move only the dragged element, with `transform`, once per frame: keep the latest pointer position and apply it in a `requestAnimationFrame` callback. Don't re-render the whole scene or list on every move; update the rest when the drag ends.

## One long task that has to stay

**Signs:** a single function with a lot of self time that does necessary work: parsing, sorting a large data set, building a big structure.

**Fix:**

- Let the browser paint the response first, then do the work. For example, show a pressed state or spinner, then continue after `await new Promise((r) => requestAnimationFrame(() => setTimeout(r)))`.
- Split the work into chunks and yield between them with `await scheduler.yield()`, falling back to `await new Promise((r) => setTimeout(r))` where it isn't supported.
- Move pure computation (no DOM) to a Web Worker.
- Do less: cache the result, compute it once on load, or compute only what's on screen.
