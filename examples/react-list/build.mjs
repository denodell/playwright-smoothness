// Minified production build with a source map, as teams ship. The CPU profile in full mode
// uses the map to name functions.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.jsx'],
  outfile: 'public/app.js',
  bundle: true,
  minify: true,
  sourcemap: 'linked',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
});
