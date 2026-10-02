// smoothness-core: the measuring engine behind playwright-smoothness, for adapters that drive it
// from a browser automation library. An adapter implements PageDriver and ElementTarget
// (driver.ts) and calls measure() or measureScroll().

// The interfaces an adapter implements.
export type { CdpSession, ElementTarget, Evaluate, PageDriver, ScratchPage, Tracer } from './driver.js';
export { detectHeadlessMode, type BrowserEnvironment } from './environment.js';

// Measuring.
export {
  COLLECTOR_CONFIG,
  emptyResult,
  machine,
  measure,
  preparePage,
  settingsOf,
  type MeasureContext,
} from './runner.js';
export { measureScroll } from './measure-scroll.js';
export { defaultScrollLabel, resolveScroll, type ResolvedScroll, type ScrollOptions } from './scroll.js';
export { resolveOptions } from './options.js';
export {
  COLLECTOR_KEY,
  installCollector,
  type CollectorConfig,
  type EventRecord,
  type LoafRecord,
  type ScrollRecord,
  type StreamBatch,
} from './collector/collector.js';

// Analysing records streamed from the page (automatic mode).
export { groupInteractions, type Interaction } from './analysis/interactions.js';
export { classifyFrames, type FrameClass } from './analysis/classify.js';
export {
  attributeFrames,
  summarizeInput,
  summarizeLongFrames,
  type AttributedFrame,
} from './analysis/aggregate.js';

// Baselines, history and reports.
export { evaluate, type MatcherOptions } from './baseline/evaluate.js';
export { compareMetrics } from './baseline/compare.js';
export type { BaselineTarget, UpdateMode } from './baseline/store.js';
export { slug } from './baseline/key.js';
export { formatMessage, formatSummary, missedBudget } from './baseline/message.js';
export { checkBudget, validateBudget } from './baseline/budget.js';
export { formatBrief, needsBrief, sourcePath, type BriefContext } from './baseline/brief.js';
export {
  appendHistory,
  historyPath,
  medianMetrics,
  outsideRecentRange,
  readHistory,
  specHash,
  type HistoryEntry,
} from './auto/history.js';
export { buildMarkdown, type ReportEntry } from './reporter/markdown.js';
export { calibrate, formatCalibration } from './calibrate/analyze.js';
export { NameResolver, resolveScripts, type FetchText } from './sourcemap/resolve.js';

// Replays.
export { encodeReplay } from './replay/encode.js';
export { takeReplaySource } from './replay/source.js';

// Files, CI and constants.
export { forwardSlashes, resultPath, writeResult, writtenPath } from './output.js';
export { onMainBranch, warnInGitHubActions } from './ci.js';
export { CALIBRATE_ENV, FORMAT_NAME, RECORD_ENV, SCHEMA_VERSION, recordingBaselines } from './constants.js';
export type * from './types.js';
