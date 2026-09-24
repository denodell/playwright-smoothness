// Public types: options and the versioned result (schemaVersion 1).

/** How much to measure. */
export type SmoothnessMode = 'quick' | 'full';

/** What happens when a check gets worse than its baseline. */
export type Enforce = 'warn' | 'fail';

/**
 * How the page is put back into its starting state between repeated runs.
 * - `'reload'`: reload the current URL, then wait until the page is settled.
 * - `'none'`: run again from wherever the last run left the page.
 * - a function: your own reset, followed by the same settle wait as `'reload'`.
 */
export type ResetStrategy =
  'reload' | 'none' | ((ctx: { page: import('@playwright/test').Page }) => Promise<void>);

export interface ListOptions {
  /** Colour treated as "blank" in list screenshots. `'auto'` samples the list's computed background. Used in M4. */
  background?: 'auto' | string;
  /** Colours or selectors whose appearance counts as blank (skeleton rows, placeholders). Used in M4. */
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
  /** Allowed increase over the baseline before a check fails, as a fraction (0.15 = 15%). Default 0.15. Used in M2. */
  maxIncrease?: number;
  /** 60, or 120 to add a reported-only 120Hz frame-budget prediction (full mode). Default 60. */
  refreshRate?: 60 | 120;
  /** `'warn'` annotates the test and lets it pass; `'fail'` fails it. Default `'warn'`. Used in M2. */
  enforce?: Enforce;
  /** Directory of baselines downloaded from the main branch, checked before the snapshot path. Used in M2. */
  baselineDir?: string;
  /** Options for `smoothness.scroll()` blank-row detection. Used in M4. */
  list?: ListOptions;
  /** How to reset the page between runs. Default `'reload'`. */
  reset?: ResetStrategy;
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
  /** Discrete interactions (clicks, taps, key presses) seen by Event Timing. Scrolling isn't included. */
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
  /** This script's share of blocking time, averaged per run. */
  blockingMs: number;
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
}
