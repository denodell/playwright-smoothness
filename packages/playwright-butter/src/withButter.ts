// Automatic mode: measures every test that uses a browser page, with no changes to the tests.
//
//   // fixtures.ts
//   import { test as base } from '@playwright/test';
//   import { withButter } from 'playwright-butter';
//   export const test = withButter(base, { auto: true });
import type {
  BrowserContext,
  Page,
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions,
  TestInfo,
  TestType,
} from '@playwright/test';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';
import {
  CALIBRATE_ENV,
  COLLECTOR_CONFIG,
  COLLECTOR_KEY,
  SCHEMA_VERSION,
  appendHistory,
  attributeFrames,
  classifyFrames,
  compareMetrics,
  formatMessage,
  formatSummary,
  groupInteractions,
  historyPath,
  installCollector,
  machine,
  medianMetrics,
  outsideRecentRange,
  onMainBranch,
  readHistory,
  resolveOptions,
  resultPath,
  settingsOf,
  specHash,
  summarizeInput,
  summarizeLongFrames,
  warnInGitHubActions,
  writeResult,
  type AttributedFrame,
  type BrowserEnvironment,
  type Comparison,
  type EventRecord,
  type FrameClass,
  type HistoryEntry,
  type Interaction,
  type LoafRecord,
  type ResolvedOptions,
  type ScrollRecord,
  type SmoothnessResult,
  type StreamBatch,
  NameResolver,
  resolveScripts,
} from 'butter-core';
import { resultDir, testOf } from './testinfo.js';
import { writeBrief } from './brief.js';
import { browserEnvironment, contextFetcher } from './driver.js';
import { smoothnessFixtures, type SmoothnessFixtures, type SmoothnessOptions } from './fixture.js';

export interface AutoOptions extends SmoothnessOptions {
  /** Measure every test automatically. */
  auto: true;
  /** How many recent main-branch runs each test's history keeps. Default 10. */
  history?: number;
  /** Runs a history needs before a test is compared with it. Default 3. */
  minHistory?: number;
  /**
   * Add this run to the history. Default: on a push build of the main branch in CI
   * (see onMainBranch), or when SMOOTHNESS_RECORD=1. Pull requests only compare.
   */
  record?: boolean;
  /** Where histories are kept. Default: `baselineDir` if set, else `.cache/playwright-smoothness/history` in the project's node_modules. */
  historyDir?: string;
}

/** Dev servers don't watch node_modules, so rewriting a history there doesn't reload pages mid-run. */
const CACHE_SUBDIR = '.cache/playwright-smoothness/history';

const FALLBACK_HISTORY_DIR = 'smoothness-history';

const PROJECT_ROOT_MARKERS = [
  '.git',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
];

const historyDirs = new Map<string, { dir: string; watched: boolean }>();

/** The nearest node_modules up to the project root, else `smoothness-history` next to the config. */
export function defaultHistoryDir(configDir: string): { dir: string; watched: boolean } {
  let found = historyDirs.get(configDir);
  if (found) return found;
  for (let d = configDir; ; d = dirname(d)) {
    const modules = join(d, 'node_modules');
    if (existsSync(modules) && statSync(modules).isDirectory()) {
      found = { dir: join(modules, CACHE_SUBDIR), watched: false };
      break;
    }
    if (PROJECT_ROOT_MARKERS.some((m) => existsSync(join(d, m))) || dirname(d) === d) {
      found = { dir: join(configDir, FALLBACK_HISTORY_DIR), watched: true };
      break;
    }
  }
  historyDirs.set(configDir, found);
  return found;
}

/** Binding the in-page collector streams records to, so they survive navigation. */
const STREAM_BINDING = '__playwrightSmoothnessStream';
/** After the test body, how long to wait for the last streamed batches to arrive. */
const STREAM_DRAIN_MS = 100;
const DEFAULT_HISTORY = 10;
const DEFAULT_MIN_HISTORY = 3;
/** Automatic mode doesn't throttle by default: it would slow every test and could break timeouts. */
const AUTO_CPU_THROTTLING = 1;
/**
 * An input this close before the page's next navigation started, with no Event Timing entry,
 * was probably never painted: Event Timing and LoAF only record an input once the next frame
 * paints. Measured from the input to the next document's timeOrigin.
 */
const UNPAINTED_INPUT_MS = 250;

export interface DocData {
  url: string;
  loaf: LoafRecord[];
  events: EventRecord[];
  scrolls: ScrollRecord[];
  loadEventEnd: number;
  /** performance.timeOrigin: when this document's navigation started (epoch ms). */
  timeOrigin: number;
  /** Which page (tab) it was in, so its next document can be found. */
  page: number;
  lastInput?: StreamBatch['lastInput'];
  errors: string[];
}

function annotate(testInfo: TestInfo, type: string, description: string) {
  testInfo.annotations.push({ type, description });
}

async function throttle(page: Page, rate: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const apply = () => cdp.send('Emulation.setCPUThrottlingRate', { rate }).catch(() => undefined);
  await apply();
  // Re-applied after each navigation, which can move the page to a new renderer process.
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) void apply();
  });
}

/** Waits until the pages' collectors have streamed everything they've seen. */
async function drain(pages: Page[]): Promise<void> {
  await Promise.all(
    pages.map((p) =>
      p
        .evaluate(async (key) => {
          const api = (window as unknown as Record<string, { flush(): Promise<void> } | undefined>)[key];
          if (api) await api.flush();
        }, COLLECTOR_KEY)
        .catch(() => undefined),
    ),
  );
  await new Promise((r) => setTimeout(r, STREAM_DRAIN_MS));
}

/**
 * The browser reports an input once the next frame paints, so a test that closes a page right
 * after its last click (in afterEach, say) would lose that click. Closing a page, or a context
 * the test created, drains its collectors first.
 */
function drainBeforeClose(context: BrowserContext, ownContext: boolean): void {
  const wrap = (p: Page) => {
    const close = p.close.bind(p);
    p.close = async (...args: Parameters<Page['close']>) => {
      await drain([p]);
      return close(...args);
    };
  };
  context.pages().forEach(wrap);
  context.on('page', wrap);
  if (ownContext) {
    const close = context.close.bind(context);
    context.close = async (...args: Parameters<BrowserContext['close']>) => {
      await drain(context.pages());
      return close(...args);
    };
  }
}

/** Analyses streamed documents: interactions, classified frames, and inputs never measured. */
export function analyzeDocs(docs: Map<number, DocData>) {
  const interactions: (Interaction & { url: string })[] = [];
  const frames: AttributedFrame[] = [];
  const classes: FrameClass[] = [];
  const errors = new Set<string>();
  const unmeasured: string[] = [];
  for (const d of docs.values()) {
    // The browser measures an input only once the next frame paints. If the page moved on to its
    // next document right after the last input, and nothing measured that input, say so.
    const next = [...docs.values()]
      .filter((o) => o.page === d.page && o.timeOrigin > d.timeOrigin)
      .sort((a, b) => a.timeOrigin - b.timeOrigin)[0];
    const input = d.lastInput;
    if (next && input && next.timeOrigin - (d.timeOrigin + input.at) <= UNPAINTED_INPUT_MS) {
      // An Event Timing entry's startTime is its event's timeStamp. Overlap isn't enough: an
      // earlier input's entry can still be running when this one arrives.
      const covered = d.events.some((e) => e.interactionId > 0 && Math.abs(e.start - input.at) <= 1);
      if (!covered) unmeasured.push(`${input.type} on ${d.url}`);
    }
    const di = groupInteractions(d.events, d.loaf);
    const dc = classifyFrames({
      loaf: d.loaf,
      interactions: di,
      scrolls: d.scrolls,
      loadEventEnd: d.loadEventEnd,
    });
    interactions.push(...di.map((i) => ({ ...i, url: d.url })));
    classes.push(...dc);
    frames.push(
      ...attributeFrames(
        d.loaf.filter((_, i) => dc[i] === 'interaction'),
        di,
        d.scrolls,
      ),
    );
    d.errors.forEach((e) => errors.add(e));
  }
  return { interactions, frames, classes, errors, unmeasured };
}

/**
 * Streams every document's records from the in-page collector into `docs`, and throttles the
 * context's pages if asked. Returns null, with an annotation, if it can't start.
 */
async function startStreaming(
  context: BrowserContext,
  resolved: ResolvedOptions,
  testInfo: TestInfo,
  docs = new Map<number, DocData>(),
  pageIds = new Map<Page, number>(),
): Promise<Map<number, DocData> | null> {
  try {
    await context.exposeBinding(STREAM_BINDING, (source, batch: StreamBatch) => {
      // A page's initial about:blank can run the collector too; there's nothing on it to measure.
      if (batch.url.startsWith('about:')) return;
      let d = docs.get(batch.doc);
      if (!d) {
        let page = pageIds.get(source.page);
        if (page === undefined) pageIds.set(source.page, (page = pageIds.size));
        d = {
          url: batch.url,
          timeOrigin: batch.doc,
          page,
          loaf: [],
          events: [],
          scrolls: [],
          loadEventEnd: 0,
          errors: [],
        };
        docs.set(batch.doc, d);
      }
      d.loaf.push(...batch.loaf);
      d.events.push(...batch.events);
      d.scrolls.push(...batch.scrolls);
      d.errors.push(...batch.errors);
      if (batch.loadEventEnd) d.loadEventEnd = batch.loadEventEnd;
      if (batch.lastInput && (!d.lastInput || batch.lastInput.at >= d.lastInput.at))
        d.lastInput = batch.lastInput;
    });
  } catch (err) {
    annotate(testInfo, 'smoothness-warning', `automatic mode couldn't start: ${String(err).split('\n')[0]}`);
    return null;
  }
  await context.addInitScript(installCollector, { ...COLLECTOR_CONFIG, stream: STREAM_BINDING });
  if (resolved.cpuThrottling > 1) {
    for (const p of context.pages()) await throttle(p, resolved.cpuThrottling);
    context.on('page', (p) => void throttle(p, resolved.cpuThrottling));
  }
  return docs;
}

/** The test's result from its streamed documents: one quick-mode run, not yet compared. */
function autoResult(
  docs: Map<number, DocData>,
  label: string,
  environment: BrowserEnvironment,
  resolved: ResolvedOptions,
): SmoothnessResult {
  const { interactions, frames, classes, errors, unmeasured } = analyzeDocs(docs);
  const count = (k: FrameClass) => classes.filter((c) => c === k).length;
  return {
    schemaVersion: SCHEMA_VERSION,
    label,
    mode: 'quick',
    runs: 1,
    browserName: environment.browserName,
    browserVersion: environment.browserVersion,
    headlessMode: environment.headlessMode,
    machine: machine(),
    cpuThrottling: resolved.cpuThrottling,
    refreshRate: resolved.refreshRate,
    settings: settingsOf(resolved),
    input: summarizeInput(interactions),
    longFrames: summarizeLongFrames(frames),
    spread: {},
    frameClasses: {
      interaction: count('interaction'),
      load: count('load'),
      background: count('background'),
    },
    unavailable: errors.size
      ? [
          {
            measurement: 'collector',
            reason: `in-page collector errors: ${[...errors].slice(0, 5).join('; ')}`,
          },
        ]
      : [],
    notes: [
      'Automatic mode: measured once, with no warm-up. The first interaction on a page can read higher on some machines (docs/measurements.md).',
      ...(resolved.mode === 'full'
        ? ['Automatic mode measures in quick mode; full mode is for measure() and scroll().']
        : []),
      ...unmeasured.map(
        (u) =>
          `The last input before a navigation (${u}) wasn't measured: the page navigated before painting it, and the browser only measures an input once it paints.`,
      ),
    ],
    auto: {
      documents: docs.size,
      interactions: interactions.map((i) => ({
        event: i.event,
        target: i.target,
        ms: i.duration,
        url: i.url,
      })),
    },
  };
}

/** A test's history as read for this run, and where to write it back. */
interface TestHistory {
  path: string;
  project: string;
  specHash: string;
  /** Empty when there's no history yet, or it restarts because the spec file changed. */
  entries: HistoryEntry[];
  /** Notes on reading the history, for the comparison. */
  notes: string[];
  watched: boolean;
}

/** Reads the test's history, starting it again if the spec file has changed since it was recorded. */
function readTestHistory(
  testInfo: TestInfo,
  label: string,
  result: SmoothnessResult,
  historyDir: string | undefined,
): TestHistory {
  // Relative paths are relative to the config file's folder, whatever directory the run started in.
  const configDir = testInfo.config.configFile ? dirname(testInfo.config.configFile) : process.cwd();
  const fallback = historyDir === undefined ? defaultHistoryDir(configDir) : null;
  const dir = fallback ? fallback.dir : resolvePath(configDir, historyDir!);
  const project = testInfo.project.name;
  const path = historyPath(dir, relative(testInfo.config.rootDir, testInfo.file), label, project, result);
  const hash = specHash(testInfo.file);
  const read = readHistory(path);
  const notes: string[] = [];
  if (typeof read === 'string') notes.push(`Ignored the history: ${read}.`);
  const historyFile = read && typeof read !== 'string' ? read : null;
  const reset = historyFile !== null && historyFile.specHash !== hash;
  const entries: HistoryEntry[] = reset || !historyFile ? [] : historyFile.entries;
  if (reset) {
    notes.push("The spec file changed since this test's history was recorded, so its history starts again.");
    annotate(testInfo, 'smoothness-baseline-reset', `${label}: spec file changed; history restarts`);
  }
  return { path, project, specHash: hash, entries, notes, watched: fallback?.watched ?? false };
}

/**
 * Compares the result with the median of the last `history` entries, once there are at least
 * `minHistory` of them. Not compared while calibrating.
 */
function compareWithHistory(
  result: SmoothnessResult,
  h: TestHistory,
  resolved: ResolvedOptions,
  calibrating: boolean,
  history: number,
  minHistory: number,
): Comparison {
  const { path, entries, notes } = h;
  if (calibrating) {
    return {
      status: 'not-compared',
      checks: [],
      baseline: null,
      notes: ['Calibrating: not compared.'],
    };
  }
  if (entries.length >= minHistory) {
    const recent = entries.slice(-history);
    const checks = outsideRecentRange(
      compareMetrics(result, medianMetrics(recent), resolved.maxIncrease),
      recent,
    );
    const worse = checks.some((c) => c.status === 'worse');
    return {
      status: worse ? (resolved.enforce === 'fail' ? 'fail' : 'warn') : 'pass',
      checks,
      baseline: {
        path,
        source: 'history',
        recordedAt: recent[recent.length - 1]!.recordedAt,
        browserVersion: recent[recent.length - 1]!.browserVersion,
        machine: result.machine,
      },
      notes: [...notes, `Compared with the median of the last ${recent.length} main-branch run(s).`],
    };
  }
  return {
    status: 'not-compared',
    checks: [],
    baseline: null,
    notes: [...notes, `Building history: ${entries.length} of ${minHistory} main-branch runs recorded.`],
  };
}

/** Adds this run to the test's history, keeping the last `history` entries, and notes it. */
function addToHistory(
  h: TestHistory,
  label: string,
  result: SmoothnessResult,
  history: number,
  comparison: Comparison,
): void {
  appendHistory(
    h.path,
    {
      test: label,
      project: h.project,
      machine: result.machine.cpuModel,
      cpuThrottling: result.cpuThrottling,
      specHash: h.specHash,
    },
    h.entries,
    result,
    history,
  );
  comparison.notes.push(`This run was added to the history (${h.path}).`);
  if (h.watched) {
    comparison.notes.push(
      'The project has no node_modules folder, so the history is kept next to the Playwright config. A dev server that watches the project reloads its pages when these files change, so add the folder to its ignored files (docs/automatic-mode.md).',
    );
  }
}

/** Writes and attaches the result, then fails, warns, or annotates according to the comparison. */
async function reportResult(
  testInfo: TestInfo,
  label: string,
  result: SmoothnessResult,
  comparison: Comparison,
): Promise<void> {
  result.test = testOf(testInfo);
  const out = resultPath(resultDir(testInfo), 'auto');
  writeResult(result, out);
  await testInfo.attach('smoothness: auto', { path: out, contentType: 'application/json' });
  await writeBrief(testInfo, 'auto', out, result, comparison);

  if (comparison.status === 'warn' || comparison.status === 'fail') {
    const summary = formatSummary(result, comparison);
    const message = formatMessage(result, comparison);
    if (comparison.status === 'fail' && testInfo.status === testInfo.expectedStatus) throw new Error(message);
    annotate(testInfo, 'smoothness-warning', summary);
    console.warn(message);
    warnInGitHubActions(summary, testInfo);
  } else if (comparison.status === 'not-compared') {
    annotate(testInfo, 'smoothness-not-compared', `${label}: ${comparison.notes.join(' ')}`);
  }
}

/**
 * Wraps a Playwright `test` so every test that opens a page is measured once, with no code
 * changes, and compared with a rolling median of recent passing runs on the main branch.
 * `butter` and `butterOptions` are available too.
 */
export function withButter<T extends object, W extends object>(
  base: TestType<T, W>,
  options: AutoOptions,
): TestType<T & SmoothnessFixtures, W> {
  const {
    auto: _auto,
    history = DEFAULT_HISTORY,
    minHistory = DEFAULT_MIN_HISTORY,
    record,
    historyDir,
    ...defaults
  } = options;
  void _auto;
  const b = base as unknown as TestType<
    PlaywrightTestArgs & PlaywrightTestOptions,
    PlaywrightWorkerArgs & PlaywrightWorkerOptions
  >;
  const extended = b.extend<SmoothnessFixtures & { _smoothnessAuto: void }>({
    ...smoothnessFixtures,
    _smoothnessAuto: [
      async ({ context, browser, butterOptions, smoothnessOptions }, use, testInfo) => {
        const environment = await browserEnvironment(context.browser());
        const resolved = resolveOptions([
          { cpuThrottling: AUTO_CPU_THROTTLING },
          defaults,
          smoothnessOptions,
          butterOptions,
        ]);
        const label = testInfo.titlePath.slice(1).join(' › ');
        if (environment.browserName !== 'chromium') {
          annotate(
            testInfo,
            'smoothness-skipped',
            `automatic mode measures Chromium only; this is ${environment.browserName}`,
          );
          await use();
          return;
        }

        const pageIds = new Map<Page, number>();
        const docs = await startStreaming(context, resolved, testInfo, new Map(), pageIds);
        if (docs) drainBeforeClose(context, false);
        const contexts = [context];
        // A test that opens its own pages (browser.newPage(), browser.newContext()) gets them in
        // contexts of its own. newPage() goes through newContext(), so wrapping that for the
        // test's duration streams those too, set up before the test can navigate.
        const newContext = browser.newContext;
        if (docs) {
          browser.newContext = async (...args: Parameters<typeof newContext>) => {
            const created = await newContext.apply(browser, args);
            await startStreaming(created, resolved, testInfo, docs, pageIds);
            drainBeforeClose(created, true);
            contexts.push(created);
            return created;
          };
        }
        try {
          await use();
        } finally {
          browser.newContext = newContext;
        }

        if (!docs) return;
        await drain(contexts.flatMap((c) => c.pages()));
        if (docs.size === 0) return; // the test never loaded a page: nothing to measure

        const result = autoResult(docs, label, environment, resolved);
        // Scripts named through the page's source maps, from each script's position in its bundle.
        if (result.longFrames) {
          const resolver = new NameResolver(contextFetcher(context));
          result.longFrames.topScripts = await resolveScripts(result.longFrames.topScripts, resolver);
          const failures = (await resolver.failures()).filter(
            (f) => !f.endsWith('it has no sourceMappingURL'),
          );
          if (failures.length)
            result.notes.push(
              `Source maps couldn't be used, so some names may be minified: ${failures.join('; ')}.`,
            );
        }

        // Compare with, and maybe add to, the history.
        const testHistory = readTestHistory(testInfo, label, result, historyDir ?? resolved.baselineDir);
        const calibrating = !!process.env[CALIBRATE_ENV];
        const comparison = compareWithHistory(
          result,
          testHistory,
          resolved,
          calibrating,
          history,
          minHistory,
        );

        const shouldRecord = record ?? (process.env.SMOOTHNESS_RECORD === '1' || onMainBranch());
        if (shouldRecord && testInfo.status === testInfo.expectedStatus && !calibrating)
          addToHistory(testHistory, label, result, history, comparison);
        result.comparison = comparison;

        await reportResult(testInfo, label, result, comparison);
      },
      { auto: true },
    ],
  });
  return extended as unknown as TestType<T & SmoothnessFixtures, W>;
}

/** @deprecated Renamed to `withButter()`. */
export const withSmoothness = withButter;
