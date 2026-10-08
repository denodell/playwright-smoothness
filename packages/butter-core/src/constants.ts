/**
 * Identifies this project's files: baselines, history and calibration output carry it in their
 * `kind`, and replays name it as their muxing app. It's the original package name, and it doesn't
 * change, so existing baselines keep loading.
 */
export const FORMAT_NAME = 'playwright-smoothness';

/** The command that runs the tools, such as `npx playwright-butter calibrate`. */
export const CLI_NAME = 'playwright-butter';

/** Version of the JSON result format. Bump only on breaking changes to the result shape. */
export const SCHEMA_VERSION = 1;

/** Tells toBeSmooth() and automatic mode not to compare or write baselines while calibrating. */
export const CALIBRATE_ENV = 'SMOOTHNESS_CALIBRATE';

export const RECORD_ENV = 'SMOOTHNESS_RECORD_BASELINES';

export function recordingBaselines(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[RECORD_ENV]?.trim().toLowerCase();
  return !!v && v !== '0' && v !== 'false';
}
