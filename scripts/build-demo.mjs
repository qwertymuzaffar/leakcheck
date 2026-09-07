// Assembles the browser demo in _site/: the page plus the library's ESM bundle.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const site = resolve(root, '_site');
rmSync(site, { recursive: true, force: true });
mkdirSync(site, { recursive: true });
cpSync(resolve(root, 'demo/index.html'), resolve(site, 'index.html'));
cpSync(resolve(root, 'dist/index.js'), resolve(site, 'leakcheck.js'));
writeFileSync(resolve(site, '.nojekyll'), '');
console.log(`demo assembled in ${site}`);
