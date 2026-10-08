import { defineConfig, type Options } from 'tsup';

// butter-core is a dependency, so it stays an import rather than being bundled in.
const shared: Options = {
  sourcemap: true,
  target: 'node20',
  tsconfig: 'tsconfig.build.json',
  external: ['@playwright/test', 'butter-core'],
};

export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/index.ts', reporter: 'src/reporter.ts' },
    format: ['esm', 'cjs'],
    // tsup's declaration build sets `baseUrl` internally, which TypeScript 6 deprecates.
    dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
    clean: true,
  },
  // The CLI is only run through `bin`, so it needs neither CommonJS nor types.
  { ...shared, entry: { cli: 'src/bin.ts' }, format: ['esm'] },
]);
