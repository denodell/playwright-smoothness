/** The published package name. Change it here, in package.json and in the docs in one commit. */
export const PACKAGE_NAME = 'playwright-smoothness';

/** Version of the JSON result format. Bump only on breaking changes to the result shape. */
export const SCHEMA_VERSION = 1;

/** Tells toBeSmooth() and automatic mode not to compare or write baselines while calibrating. */
export const CALIBRATE_ENV = 'SMOOTHNESS_CALIBRATE';
