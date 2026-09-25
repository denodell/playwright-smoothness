import { defineConfig } from 'tsup';

const shared = {
  sourcemap: true,
  target: 'node20',
  external: ['@playwright/test'],
} as const;

export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/index.ts', reporter: 'src/reporter/index.ts' },
    format: ['esm', 'cjs'],
    // tsup's declaration build sets `baseUrl` internally, which TypeScript 6 deprecates.
    dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
    clean: true,
  },
  // The CLI is only run through `bin`, so it needs neither CommonJS nor types.
  { ...shared, entry: { cli: 'src/bin.ts' }, format: ['esm'] },
]);
