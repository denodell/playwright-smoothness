---
'playwright-smoothness': minor
---

Full mode (`mode: 'full'`): each run is traced with a minimal category set (about 240KB per interaction) and windowed by in-page marks. Adds `frames` (on-time and dropped frames from Chrome's frame reporter), gated on `frames.onTimePercent`, and with `refreshRate: 120` a reported-only `budget120` prediction. Missing trace events or fields are reported as unavailable, with the Chrome version.
