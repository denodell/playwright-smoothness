import type { Page } from '@playwright/test';
import type { ResetStrategy as CoreResetStrategy } from 'butter-core';

export { test } from './fixture.js';
export { withButter, withSmoothness } from './withButter.js';
export type { AutoOptions } from './withButter.js';
export type {
  ButterTestOptions,
  Smoothness,
  SmoothnessFixtures,
  SmoothnessOptions,
  SmoothnessTestOptions,
} from './fixture.js';
export { expect } from './matcher.js';
export { PACKAGE_NAME } from './constants.js';
export { SCHEMA_VERSION } from 'butter-core';
// The result and option types, from the engine. SmoothnessOptions and ResetStrategy are the
// Playwright forms, which pass a Playwright Page to a reset function.
export type {
  BaselineInfo,
  Budget,
  Budget120Result,
  BudgetCheck,
  BudgetStatus,
  Check,
  CheckStatus,
  Comparison,
  ComparisonStatus,
  Enforce,
  FramesResult,
  HeadlessMode,
  HotFunction,
  InputResult,
  ListOptions,
  ListResult,
  LongFramesResult,
  MatcherOptions,
  ProfileResult,
  ReplayMode,
  ResolvedOptions,
  ScrollOptions,
  SmoothnessMode,
  SmoothnessResult,
  Spread,
  TargetTiming,
  TopScript,
  Unavailable,
} from 'butter-core';
export type ResetStrategy = CoreResetStrategy<Page>;
