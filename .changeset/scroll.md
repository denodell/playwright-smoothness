---
'playwright-smoothness': minor
---

`smoothness.scroll(locator, options)`: measures a list scrolled by wheel, touch (compositor-driven gestures) or arrow keys, vertically or horizontally. In full mode it detects blank frames from the trace's screenshots (`list.blankFramePercent`, gated, and `list.leastDrawnPercent`), with `list.background` and `list.placeholders` to say what counts as blank.
