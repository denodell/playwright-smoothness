// Public types: options and the versioned result (schemaVersion 1).
import type { Page } from '@playwright/test';

/** How much to measure. */
export type SmoothnessMode = 'quick' | 'full';

/** When `scroll()` attaches a video replay. */
export type ReplayMode = 'on-regression' | 'on' | 'off';

/** What happens when a check gets worse than its baseline. */
export type Enforce = 'warn' | 'fail';

/**
 * How the page is put back into its starting state between repeated runs.
 * - `'reload'`: reload the current URL, then wait until the page is settled.
 * - `'none'`: run again from wherever the last run left the page.
 * - a function: your own reset, followed by the same settle wait as `'reload'`.
 */
export type ResetStrategy = 'reload' | 'none' | ((ctx: { page: Page }) => Promise<void>);

export interface ListOptions {
  /** Colour treated as "blank" in list screenshots. `'auto'` samples the list's computed background. */
  background?: 'auto' | string;
  /** Colours or selectors whose appearance counts as blank (skeleton rows, placeholders). */
  placeholders?: string[];
}

export interface SmoothnessOptions {
  /**
   * `'quick'` measures with Event Timing and Long Animation Frames. `'full'` adds a Chrome
   * trace and screenshots. Default: `SMOOTHNESS_MODE` if set, `'full'` on scheduled CI runs,
   * otherwise `'quick'` (see docs/mode-detection.md).
   */
  mode?: SmoothnessMode;
  /** Measured runs. The median is reported. One extra warm-up run is made first and discarded. Default 5. */
  runs?: number;
  /** CPU slowdown applied with `Emulation.setCPUThrottlingRate`. 1 disables it. Default 4. */
  cpuThrottling?: number;
  /** Allowed increase over the baseline before a check counts as worse, as a fraction (0.15 = 15%). Default 0.15. */
  maxIncrease?: number;
  /** 60, or 120 to add a reported-only 120Hz frame-budget prediction (full mode). Default 60. */
  refreshRate?: 60 | 120;
  /** `'warn'` annotates the test and lets it pass; `'fail'` fails it. Default `'warn'`. */
  enforce?: Enforce;
  /** Directory of baselines downloaded from the main branch, checked before the snapshot path. */
  baselineDir?: string;
  /** Options for `smoothness.scroll()` blank-row detection. */
  list?: ListOptions;
  /** How to reset the page between runs. Default `'reload'`. */
  reset?: ResetStrategy;
  /**
   * A video replay of `scroll()` in full mode, attached to the test report: each frame with how
   * drawn the list was and a timeline of blank frames, 4x slower than real time.
   * `'on-regression'` (default) attaches it when a check got worse; `'on'` always; `'off'` never.
   */
  replay?: ReplayMode;
  /**
   * Also gate on `longFrames.totalBlockingMs`. Off by default: it can vary ±25–40% between runs on
   * a slow single-CPU machine (docs/measurements.md), so it's reported but not gated unless you ask. Default false.
   */
  gateTotalBlocking?: boolean;
}

/** Options after defaults are applied, plus where `mode` came from. */
export interface ResolvedOptions {
  mode: SmoothnessMode;
  modeSource: string;
  runs: number;
  cpuThrottling: number;
  maxIncrease: number;
  refreshRate: 60 | 120;
  enforce: Enforce;
  baselineDir: string | undefined;
  list: Required<ListOptions>;
  reset: ResetStrategy;
  gateTotalBlocking: boolean;
  replay: ReplayMode;
}

export type HeadlessMode = 'headless-shell' | 'new-headless' | 'headed' | 'unknown';

/** A measurement that couldn't be taken, and why. Never reported as zero instead. */
export interface Unavailable {
  measurement: string;
  reason: string;
}

export interface TargetTiming {
  /** Element description, such as `button#checkout`, or `unknown`. */
  target: string;
  /** Event type that took longest for this target, such as `click` or `keydown`. */
  event: string;
  /** Input-to-paint time in ms (median across runs). */
  ms: number;
}

export interface InputResult {
  /**
   * Discrete interactions (clicks, taps, key presses) that took 16ms or more, Event Timing's
   * minimum threshold; faster ones aren't reported by the browser. Scrolling isn't included.
   */
  interactions: number;
  /** 95th percentile input-to-paint time in ms. Null when there were no interactions. */
  p95ToPaintMs: number | null;
  /** Slowest interaction in ms. Null when there were no interactions. */
  worstMs: number | null;
  byTarget: TargetTiming[];
}

export interface TopScript {
  /** Script URL, as reported by LoAF. */
  source: string;
  /** Function name, when the browser knows it. */
  fn: string;
  /** What ran the script, such as `BUTTON#buy.onclick`. */
  invoker: string;
  /** `event-listener`, `user-callback`, `classic-script`, and so on. */
  invokerType: string;
  /** This script's share of blocking time (frame time beyond 50ms), averaged per run. */
  blockingMs: number;
  /** How long the script ran, averaged per run. */
  durationMs: number;
  /**
   * The interactions whose frames this script blocked, such as `click on button#checkout` or
   * `scroll on div#feed`. Frameworks put their own dispatcher between the browser and your
   * handler (React's root listener, Zone.js's wrapper), so `fn` and `invoker` often name the
   * framework; this names what the user actually interacted with (see docs/frameworks.md).
   */
  during: string[];
}

export interface LongFramesResult {
  /** Long animation frames (over 50ms) caused by the interaction. Load and background frames are excluded. */
  count: number;
  /** Sum of LoAF `blockingDuration`. Reported, but only gated when asked (it's noisy). */
  totalBlockingMs: number;
  /** Longest frame in ms, or null when there were none. */
  worstMs: number | null;
  topScripts: TopScript[];
}

/** Frame delivery from the Chrome trace (full mode). */
export interface FramesResult {
  /** Frames that had an update to show: presented plus dropped. */
  total: number;
  /** Presented in full or in part (`STATE_PRESENTED_ALL`, `STATE_PRESENTED_PARTIAL`). */
  onTime: number;
  /** `STATE_DROPPED`: an update missed its frame. */
  dropped: number;
  /** onTime / total × 100. Null when no frame had an update (nothing to be on time for). */
  onTimePercent: number | null;
}

/** A function that used CPU during the interaction, from the V8 sampling profiler (full mode). */
export interface HotFunction {
  /** Function name, `(anonymous)`, or a V8 pseudo-frame such as `(program)` (browser work outside JavaScript) or `(garbage collector)`. */
  fn: string;
  url: string;
  /** 1-based, 0 when unknown. */
  line: number;
  /** 1-based, 0 when unknown. */
  column: number;
  /** Time sampled in this function itself, averaged per run. */
  selfMs: number;
  /** Time sampled in this function or anything it called, averaged per run. */
  totalMs: number;
  /** The most common callers, nearest first: `['onCheckout', 'executeDispatch', …]`. */
  callers: string[];
  /**
   * Set when a source map resolved this function: its minified name and bundle position.
   * `fn`, `url`, `line` and `column` are then the original ones.
   */
  generated?: { fn: string; url: string; line: number; column: number };
}

export interface ProfileResult {
  /** Functions ranked by self time during the interaction (its long frames and Event Timing windows). */
  hotFunctions: HotFunction[];
  /** JavaScript and browser time sampled in those windows, averaged per run (idle excluded). */
  sampledMs: number;
}

/** A 120Hz prediction from AnimationFrame durations (full mode, refreshRate 120). Never gated. */
export interface Budget120Result {
  /** Main-thread frames longer than 8.33ms, the 120Hz budget. */
  framesOverBudget: number;
  /** Main-thread frames measured. */
  frames: number;
  /** Always true: headless Chrome runs at 60Hz, so 120Hz is predicted, not observed. */
  predicted: true;
}

/** Blank rows while scrolling a list, from trace screenshots (`scroll()` in full mode). */
export interface ListResult {
  /** Screenshots analysed: one per frame the compositor produced while the list moved. */
  frames: number;
  /** Frames drawn to less than half of the list at rest. */
  blankFrames: number;
  /** blankFrames / frames × 100. Gated. */
  blankFramePercent: number;
  /** The least-drawn frame, as a percentage of the list at rest. */
  leastDrawnPercent: number;
}

export interface Spread {
  min: number;
  median: number;
  max: number;
}

export interface SmoothnessResult {
  schemaVersion: 1;
  label: string;
  mode: SmoothnessMode;
  /** Measured runs (the warm-up isn't counted). */
  runs: number;
  browserName: string;
  browserVersion: string;
  headlessMode: HeadlessMode;
  /**
   * The machine the browser ran on. GitHub's hosted runners vary about 2x in speed between
   * jobs (docs/measurements.md), so baselines are only comparable on the same kind of machine.
   */
  machine: { cpuModel: string; cpus: number; platform: string };
  cpuThrottling: number;
  refreshRate: 60 | 120;
  /** The options that decide how this result is compared, recorded for reports and CI scripts. */
  settings: {
    maxIncrease: number;
    enforce: Enforce;
    gateTotalBlocking: boolean;
    baselineDir: string | null;
    /** Which rule chose `mode` (docs/mode-detection.md). */
    modeSource: string;
    replay: ReplayMode;
  };
  /** Full mode only. */
  frames?: FramesResult | null;
  /** `scroll()` in full mode only. */
  list?: ListResult | null;
  /** Full mode with refreshRate 120 only. Reported, never gated. */
  budget120?: Budget120Result | null;
  /** Full mode only: where CPU time went during the interaction. Reported, never gated. */
  profile?: ProfileResult | null;
  /** Automatic mode only: every interaction in the test, in order. */
  auto?: {
    /** Documents the test loaded (each navigation is a new one). */
    documents: number;
    interactions: { event: string; target: string; ms: number; url: string }[];
  };
  /** `scroll()` only: what was scrolled, and how. */
  scroll?: {
    input: 'wheel' | 'touch' | 'keys';
    direction: 'vertical' | 'horizontal';
    /** Null for keys. */
    speedPxPerSec: number | null;
    /** Median across runs. */
    requestedPx: number;
    /** Median across runs. */
    scrolledPx: number;
    /**
     * Keys only: arrow-key presses per run. Event Timing reports only interactions of 16ms or
     * more (its minimum threshold), so `input.interactions` counts the slow presses among these.
     */
    keyPresses?: number;
  };
  /** Null when Event Timing couldn't be measured (see `unavailable`). */
  input: InputResult | null;
  /** Null when LoAF couldn't be measured (see `unavailable`). */
  longFrames: LongFramesResult | null;
  /** Min, median and max across runs for each headline number that was measured. */
  spread: Record<string, Spread>;
  /** How many long frames of each kind were seen, median per run. Only `interaction` frames are gated. */
  frameClasses: { interaction: number; load: number; background: number };
  unavailable: Unavailable[];
  /** Human-readable notes about the measurement itself (settle timeouts, headless shell, and so on). */
  notes: string[];
  /** Set by `toBeSmooth()`: how this result compared with its baseline. */
  comparison?: Comparison;
  /** The replay video's file name, next to this JSON, when one was attached. */
  replay?: string;
}

/**
 * - `pass`: within the allowed increase.
 * - `worse`: past the allowed increase.
 * - `unavailable`: measured in the baseline but not now (see the result's `unavailable`).
 * - `not-compared`: measured now, but the baseline has no value to compare with.
 */
export type CheckStatus = 'pass' | 'worse' | 'unavailable' | 'not-compared';

export interface Check {
  /** Result field, such as `input.p95ToPaintMs`. */
  metric: string;
  /** Plain name, such as `input-to-paint (p95)`. */
  name: string;
  unit: 'ms' | 'count' | '%';
  current: number | null;
  baseline: number | null;
  /** current − baseline, in the metric's unit. */
  change: number | null;
  /** Change as a percentage of the baseline, or null when the baseline is 0. */
  changePercent: number | null;
  /** The largest change allowed before the check is `worse`. */
  allowed: number | null;
  status: CheckStatus;
  reason?: string;
  /** True when this check varied across runs by more than maxIncrease; see `calibrate`. */
  noisy?: boolean;
  /** (max − min) / median across runs, as a percentage. */
  spreadPercent?: number;
}

/**
 * - `pass`: every gated check is within its allowance.
 * - `warn` / `fail`: at least one check is worse; which one depends on `enforce`.
 * - `baseline-created`: no baseline existed, so this result became it.
 * - `baseline-updated`: `--update-snapshots` replaced the baseline.
 * - `not-compared`: nothing could be compared (no measurement, or no baseline and updates are off).
 */
export type ComparisonStatus =
  'pass' | 'warn' | 'fail' | 'baseline-created' | 'baseline-updated' | 'not-compared';

export interface BaselineInfo {
  path: string;
  /** `history` is automatic mode's rolling median of recent main-branch runs. */
  source: 'baselineDir' | 'snapshot' | 'history';
  recordedAt: string;
  browserVersion: string;
  machine: SmoothnessResult['machine'];
}

export interface Comparison {
  status: ComparisonStatus;
  checks: Check[];
  baseline: BaselineInfo | null;
  notes: string[];
}
