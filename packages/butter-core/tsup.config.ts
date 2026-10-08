import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  sourcemap: true,
  // The maps point at the original files without carrying their text, which would add the
  // embedded replay font (replay/font.ts) to every map.
  esbuildOptions(options) {
    options.sourcesContent = false;
  },
  target: 'node20',
  tsconfig: 'tsconfig.build.json',
  // tsup's declaration build sets `baseUrl` internally, which TypeScript 6 deprecates.
  dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
  clean: true,
});
