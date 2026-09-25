// Automatic mode: measures every test that uses a browser page, with no changes to the tests.
//
//   // fixtures.ts
//   import { test as base } from '@playwright/test';
//   import { withSmoothness } from 'playwright-smoothness';
//   export const test = withSmoothness(base, { auto: true });
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
import { dirname, relative, resolve as resolvePath } from 'node:path';
import { cpus, platform } from 'node:os';
import {
  installCollector,
  type EventRecord,
  type LoafRecord,
  type ScrollRecord,
  type StreamBatch,
} from '../collector/collector.js';
import { COLLECTOR_CONFIG, settingsOf } from '../runner.js';
import { groupInteractions, type Interaction } from '../analysis/interactions.js';
import { classifyFrames, type FrameClass } from '../analysis/classify.js';
import {
  attributeFrames,
  summarizeInput,
  summarizeLongFrames,
  type AttributedFrame,
} from '../analysis/aggregate.js';
import { compareMetrics } from '../baseline/compare.js';
import { formatMessage, formatSummary } from '../baseline/message.js';
import { resolveOptions } from '../options.js';
import { browserEnvironment } from '../environment.js';
import { githubWarning, inGitHubActions, onMainBranch } from '../ci.js';
import { resultPath, writeResult } from '../output.js';
import { SCHEMA_VERSION } from '../constants.js';
import { smoothnessFixtures, type SmoothnessFixtures } from '../fixture.js';
import {
  appendHistory,
  historyPath,
  medianMetrics,
  readHistory,
  specHash,
  type HistoryEntry,
} from './history.js';
import type { Comparison, SmoothnessOptions, SmoothnessResult } from '../types.js';

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
  /** Where histories are kept. Default: `baselineDir` if set, else `smoothness-history` in the config's folder. */
  historyDir?: string;
}

/** Binding the in-page collector streams records to, so they survive navigation. */
export const STREAM_BINDING = '__playwrightSmoothnessStream';
/** After the test body, how long to wait for the last streamed batches to arrive. */
export const STREAM_DRAIN_MS = 100;
export const DEFAULT_HISTORY = 10;
export const DEFAULT_MIN_HISTORY = 3;
/** Automatic mode doesn't throttle by default: it would slow every test and could break timeouts. */
export const AUTO_CPU_THROTTLING = 1;
/**
 * An input this close before the page's next navigation started, with no Event Timing entry,
 * was probably never painted: Event Timing and LoAF only record an input once the next frame
 * paints. Measured from the input to the next document's timeOrigin.
 */
export const UNPAINTED_INPUT_MS = 250;

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

async function drain(context: BrowserContext): Promise<void> {
  await Promise.all(
    context.pages().map((p) =>
      p
        .evaluate(async (key) => {
          const api = (window as unknown as Record<string, { flush(): Promise<void> } | undefined>)[key];
          if (api) await api.flush();
        }, '__playwrightSmoothness')
        .catch(() => undefined),
    ),
  );
  await new Promise((r) => setTimeout(r, STREAM_DRAIN_MS));
}

/** Analyses streamed documents: interactions, classified frames, and inputs never measured. */
export function analyse(docs: Map<number, DocData>) {
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
      const covered = d.events.some(
        (e) => e.interactionId > 0 && e.start <= input.at + 1 && e.start + e.duration >= input.at - 1,
      );
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
 * Wraps a Playwright `test` so every test that opens a page is measured once, with no code
 * changes, and compared with a rolling median of recent passing runs on the main branch.
 * `smoothness` and `smoothnessOptions` are available too.
 */
export function withSmoothness<T extends object, W extends object>(
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
      async ({ context, smoothnessOptions }, use, testInfo) => {
        const browser = context.browser();
        const environment = await browserEnvironment(browser);
        const resolved = resolveOptions([
          { cpuThrottling: AUTO_CPU_THROTTLING },
          defaults,
          smoothnessOptions,
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

        const docs = new Map<number, DocData>();
        const pageIds = new Map<Page, number>();
        let bound = true;
        try {
          await context.exposeBinding(STREAM_BINDING, (source, batch: StreamBatch) => {
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
          bound = false;
          annotate(
            testInfo,
            'smoothness-warning',
            `automatic mode couldn't start: ${String(err).split('\n')[0]}`,
          );
        }
        if (bound) {
          await context.addInitScript(installCollector, { ...COLLECTOR_CONFIG, stream: STREAM_BINDING });
          if (resolved.cpuThrottling > 1) {
            for (const p of context.pages()) await throttle(p, resolved.cpuThrottling);
            context.on('page', (p) => void throttle(p, resolved.cpuThrottling));
          }
        }

        await use();

        if (!bound) return;
        await drain(context);
        if (docs.size === 0) return; // the test never loaded a page: nothing to measure

        const { interactions, frames, classes, errors, unmeasured } = analyse(docs);
        const count = (k: FrameClass) => classes.filter((c) => c === k).length;
        const list = cpus();
        const result: SmoothnessResult = {
          schemaVersion: SCHEMA_VERSION,
          label,
          mode: 'quick',
          runs: 1,
          browserName: environment.browserName,
          browserVersion: environment.browserVersion,
          headlessMode: environment.headlessMode,
          machine: { cpuModel: list[0]?.model.trim() ?? 'unknown', cpus: list.length, platform: platform() },
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

        // Compare with, and maybe add to, the history.
        // Relative paths are relative to the config file's folder, whatever directory the run started in.
        const configDir = testInfo.config.configFile ? dirname(testInfo.config.configFile) : process.cwd();
        const dir = resolvePath(configDir, historyDir ?? resolved.baselineDir ?? 'smoothness-history');
        const project = testInfo.project.name;
        const path = historyPath(
          dir,
          relative(testInfo.config.rootDir, testInfo.file),
          label,
          project,
          result,
        );
        const hash = specHash(testInfo.file);
        const read = readHistory(path);
        const notes: string[] = [];
        if (typeof read === 'string') notes.push(`Ignored the history: ${read}.`);
        const historyFile = read && typeof read !== 'string' ? read : null;
        const reset = historyFile !== null && historyFile.specHash !== hash;
        const entries: HistoryEntry[] = reset || !historyFile ? [] : historyFile.entries;
        if (reset) {
          notes.push(
            "The spec file changed since this test's history was recorded, so its history starts again.",
          );
          annotate(testInfo, 'smoothness-baseline-reset', `${label}: spec file changed; history restarts`);
        }

        let comparison: Comparison;
        if (process.env.SMOOTHNESS_CALIBRATE) {
          comparison = {
            status: 'not-compared',
            checks: [],
            baseline: null,
            notes: ['Calibrating: not compared.'],
          };
        } else if (entries.length >= minHistory) {
          const recent = entries.slice(-history);
          const checks = compareMetrics(result, medianMetrics(recent), resolved.maxIncrease);
          const worse = checks.some((c) => c.status === 'worse');
          comparison = {
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
        } else {
          comparison = {
            status: 'not-compared',
            checks: [],
            baseline: null,
            notes: [
              ...notes,
              `Building history: ${entries.length} of ${minHistory} main-branch runs recorded.`,
            ],
          };
        }

        const shouldRecord = record ?? (process.env.SMOOTHNESS_RECORD === '1' || onMainBranch());
        if (
          shouldRecord &&
          testInfo.status === testInfo.expectedStatus &&
          !process.env.SMOOTHNESS_CALIBRATE
        ) {
          appendHistory(
            path,
            {
              test: label,
              project,
              machine: result.machine.cpuModel,
              cpuThrottling: result.cpuThrottling,
              specHash: hash,
            },
            entries,
            result,
            history,
          );
          comparison.notes.push(`This run was added to the history (${path}).`);
        }
        result.comparison = comparison;

        const out = resultPath(testInfo, 'auto');
        writeResult(result, out);
        await testInfo.attach('smoothness: auto', { path: out, contentType: 'application/json' });

        if (comparison.status === 'warn' || comparison.status === 'fail') {
          const summary = formatSummary(result, comparison);
          const message = formatMessage(result, comparison);
          if (comparison.status === 'fail' && testInfo.status === testInfo.expectedStatus)
            throw new Error(message);
          annotate(testInfo, 'smoothness-warning', summary);
          console.warn(message);
          if (inGitHubActions()) {
            console.log(
              githubWarning(summary, { file: relative(process.cwd(), testInfo.file), line: testInfo.line }),
            );
          }
        } else if (comparison.status === 'not-compared') {
          annotate(testInfo, 'smoothness-not-compared', `${label}: ${comparison.notes.join(' ')}`);
        }
      },
      { auto: true },
    ],
  });
  return extended as unknown as TestType<T & SmoothnessFixtures, W>;
}
