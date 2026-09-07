import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts', node: 'src/node.ts' },
    format: ['esm', 'cjs'],
    // Self-contained files: the browser demo loads index.js on its own.
    splitting: false,
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2022',
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    banner: { js: '#!/usr/bin/env node' },
    sourcemap: true,
    target: 'es2022',
    // The CLI imports the library from its own build output, so nothing is bundled twice.
    external: ['./index.js', './node.js'],
  },
]);
