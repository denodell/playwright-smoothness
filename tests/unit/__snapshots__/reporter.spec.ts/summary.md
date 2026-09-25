## Smoothness

**2 got worse** · 1 within baseline · 1 new baseline · 2 not compared

| | Measurement | Check | Now | Baseline | Allowed |
|---|---|---|---|---|---|
| **Worse** | filters › open › "open filters" [chromium] | input-to-paint (p95) | 176ms (+67ms, +61.5%) | 109ms | +16.3ms |
| **Failed** | checkout › "pay" [chromium] | long frames | 3 (+2, +200%) | 1 | +1 |
| OK | filters › open › "open filters" [chromium] | long frames | 1 (no change) | 1 | +1 |
| OK | checkout › "pay" [chromium] | input-to-paint (p95) | 112ms (+3ms, +2.8%) | 109ms | +16.3ms |
| OK | search › "type" [chromium] | input-to-paint (p95) | 104ms (−5ms, −4.6%) | 109ms | +16.3ms |
| OK | search › "type" [chromium] | long frames | 1 (no change) | 1 | +1 |

### What got worse

#### filters › open › "open filters" [chromium] (warning)

- input-to-paint (p95): 176ms (+67ms, +61.5%); slowest: click on `button#filters`

Scripts blocking the interaction:

1. onFilterClick in app.js (BUTTON#filters.onclick): ran 108ms, 58ms of it blocking, during click on button#filters

#### checkout › "pay" [chromium]

- long frames: 3 (+2, +200%)

Scripts blocking the interaction:

1. onFilterClick in app.js (BUTTON#filters.onclick): ran 108ms, 58ms of it blocking, during click on button#filters

### Not measured, not compared, or new

- catalogue › "fling" [chromium]: new baseline recorded (chromium, full mode, AMD EPYC 7763 64-Core Processor)
- catalogue › "fling" [firefox]: input unavailable: smoothness is measured in Chromium only; this is firefox
- catalogue › "fling" [firefox]: longFrames unavailable: smoothness is measured in Chromium only; this is firefox
- catalogue › "fling" [firefox]: not compared: Nothing was measured: Chromium only.
- menu › "open menu" [chromium]: not compared, because `toBeSmooth()` wasn't called

<sub>chromium 153.0.8010.12 (new-headless), firefox 145.0 (new-headless) · AMD EPYC 7763 64-Core Processor (4 CPUs)</sub>
