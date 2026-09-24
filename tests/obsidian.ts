import { vi } from 'vitest';
export class App {}
export class Plugin { app: any; saveData = vi.fn(async () => {}); }
export class PluginSettingTab {}
export class SecretComponent {}
export class Setting {}
export class TFile { constructor(public path = '') {} }
export class MarkdownView {
  file: TFile | null = null;
  editor = { getValue: () => '' };
  getMode() { return 'source'; }
}
export const Notice = vi.fn();
export const requestUrl = vi.fn();
export const normalizePath = (path: string) => path.replace(/\/{2,}/g, '/');
// Fixtures use valid YAML consisting of JSON-compatible single-line values.
export const parseYaml = (text: string) => Object.fromEntries(text.split('\n').map(line => {
  const split = line.indexOf(':');
  return [line.slice(0, split), JSON.parse(line.slice(split + 1).trim())];
}));
const element = () => ({ createEl: vi.fn(() => element()) });
export class Modal {
  contentEl = element();
  constructor(_app: unknown) {}
  setTitle() {}
  open() {}
}
