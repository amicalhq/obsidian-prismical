import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  external: ['obsidian'],
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  sourcemap: false,
});
await copyFile('manifest.json', 'dist/manifest.json');
await copyFile('THIRD-PARTY-NOTICES.md', 'dist/THIRD-PARTY-NOTICES.md');
await copyFile('LICENSE', 'dist/LICENSE');
