// Builds the framework test pages into test-pages/frameworks/dist/ with esbuild.
// Each app is built twice: 'prod' (minified, as teams ship) and 'dev' (readable names).
// Both have external source maps, so the framework check can see what source maps recover.
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = 'test-pages/frameworks';
const out = join(root, 'dist');
mkdirSync(out, { recursive: true });

const apps = [
  { name: 'react', entry: 'src/react.jsx', define: {} },
  { name: 'angular-zone', entry: 'src/angular.ts', define: { ZONE: 'true' } },
  { name: 'angular-zoneless', entry: 'src/angular.ts', define: { ZONE: 'false' } },
];

const pages = [];
for (const app of apps) {
  for (const variant of ['prod', 'dev']) {
    const file = `${app.name}.${variant}`;
    await build({
      entryPoints: [join(root, app.entry)],
      outfile: join(out, `${file}.js`),
      bundle: true,
      format: 'esm',
      splitting: false,
      target: 'es2022',
      minify: variant === 'prod',
      sourcemap: 'linked',
      jsx: 'automatic',
      logLevel: 'warning',
      define: {
        ...app.define,
        'process.env.NODE_ENV': JSON.stringify(variant === 'prod' ? 'production' : 'development'),
      },
      // Angular's JIT needs legacy decorators and [[Set]] class fields.
      tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
    });
    const body = app.name === 'react' ? '<div id="root"></div>' : '<app-root></app-root>';
    writeFileSync(
      join(out, `${file}.html`),
      `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${file}</title></head>\n<body>\n${body}\n<script type="module" src="./${file}.js"></script>\n</body>\n</html>\n`,
    );
    pages.push(file);
  }
}
console.log(`built framework pages: ${pages.join(', ')}`);
