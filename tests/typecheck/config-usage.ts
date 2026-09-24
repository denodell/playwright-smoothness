// Compile-only: the config usage shown in README and docs/ci.md must typecheck.
import { defineConfig } from '@playwright/test';
import type { SmoothnessTestOptions } from '../../src/index.js';

export const plain = defineConfig({
  use: { channel: 'chromium' },
});

export const withOptions = defineConfig<SmoothnessTestOptions>({
  use: {
    channel: 'chromium',
    smoothnessOptions: { baselineDir: process.env.SMOOTHNESS_BASELINE_DIR, enforce: 'fail' },
  },
});
