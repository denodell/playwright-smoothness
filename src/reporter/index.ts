// playwright-smoothness/reporter: writes a markdown summary of every smoothness result.
//
//   reporter: [['list'], ['playwright-smoothness/reporter', { outputFile: 'smoothness.md' }]]
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { forwardSlashes } from '../output.js';
import type { FullConfig, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import type { SmoothnessResult } from '../types.js';
import { buildMarkdown, type ReportEntry } from './markdown.js';

export interface SmoothnessReporterOptions {
  /** Where to write the markdown. Default: `smoothness/summary.md` in the first project's output directory. */
  outputFile?: string;
  /** Heading of the summary. Default `Smoothness`. */
  title?: string;
  /** Also append to the GitHub Actions job summary ($GITHUB_STEP_SUMMARY). Default: true when it's set. */
  githubSummary?: boolean;
}

const ATTACHMENT_PREFIX = 'smoothness: ';

export default class SmoothnessReporter implements Reporter {
  private entries: ReportEntry[] = [];
  private outputFile = '';
  private rootDir = process.cwd();

  constructor(private readonly options: SmoothnessReporterOptions = {}) {}

  onBegin(config: FullConfig): void {
    this.rootDir = config.rootDir;
    const outputDir = config.projects[0]?.outputDir ?? join(config.rootDir, 'test-results');
    this.outputFile = this.options.outputFile
      ? resolve(this.options.outputFile)
      : join(outputDir, 'smoothness', 'summary.md');
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    for (const a of result.attachments) {
      if (!a.name.startsWith(ATTACHMENT_PREFIX) || !a.path || !existsSync(a.path)) continue;
      try {
        const r = JSON.parse(readFileSync(a.path, 'utf8')) as SmoothnessResult;
        if (r.schemaVersion !== 1) continue;
        this.entries.push({
          test: test.titlePath().slice(3).join(' › ') || test.title,
          file: forwardSlashes(relative(this.rootDir, test.location.file)),
          project: test.parent.project()?.name ?? '',
          result: r,
        });
      } catch {
        // A result file that can't be read is left out; the test's own report still has it.
      }
    }
  }

  onEnd(): void {
    if (!this.outputFile) return;
    const md = buildMarkdown(this.entries, this.options.title);
    mkdirSync(dirname(this.outputFile), { recursive: true });
    writeFileSync(this.outputFile, md);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary && this.options.githubSummary !== false) appendFileSync(summary, md + '\n');
    if (this.entries.length) console.log(`Smoothness summary: ${relative(process.cwd(), this.outputFile)}`);
  }

  printsToStdio(): boolean {
    return false;
  }
}
