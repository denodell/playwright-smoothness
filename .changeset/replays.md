---
'playwright-smoothness': minor
---

Replays: when a full-mode `scroll()` check gets worse, a WebM video of the measured scroll is attached to the test, 4x slower than real time, with each frame's drawn share, blank frames marked, and a timeline. `replay: 'on' | 'off' | 'on-regression'` (default `'on-regression'`). Built from the frames the measurement already recorded, with no dependencies.
