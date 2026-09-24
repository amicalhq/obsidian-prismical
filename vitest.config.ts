import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { obsidian: new URL('./tests/obsidian.ts', import.meta.url).pathname } },
});
