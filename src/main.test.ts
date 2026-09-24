import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { MarkdownView, requestUrl, TFile } from 'obsidian';
import PrismicalSync, { safeTitle, splitFile } from './main';

function fileAt(path: string): TFile {
  return Object.assign(new TFile(), { path });
}

function setup() {
  const plugin = new PrismicalSync({} as any, {} as any);
  const files = new Map<TFile, string>();
  const caches = new Map<TFile, any>();
  const leaves: any[] = [];
  const marker = crypto.randomUUID();
  plugin.settings.enabled = true;
  const app = {
    secretStorage: { getSecret: () => 'test-key' },
    loadLocalStorage: () => marker,
    saveLocalStorage: vi.fn(),
    metadataCache: { getFileCache: (file: TFile) => caches.get(file) },
    workspace: { getLeavesOfType: () => leaves },
    vault: {
      getMarkdownFiles: () => [...files.keys()],
      read: vi.fn(async (file: TFile) => files.get(file)!),
      process: vi.fn(async (file: TFile, update: (text: string) => string) => files.set(file, update(files.get(file)!))),
      getAbstractFileByPath: (path: string) => [...files.keys()].find(file => file.path === path),
      createFolder: vi.fn(async () => {}),
      create: vi.fn(async (path: string, text: string) => files.set(fileAt(path), text)),
    },
  };
  plugin.app = app as any;
  (plugin as any).status = { setText: vi.fn() };
  vi.mocked(requestUrl).mockResolvedValue({ status: 200, headers: {}, text: JSON.stringify({ org_user_id: 'user', org: { id: 'org' } }) } as any);
  const add = (id: string, body = 'base') => {
    const file = fileAt(`${id}.md`);
    const meta = { prismical_note_id: id, prismical_org_id: 'org', prismical_api: 'https://api.prismical.ai' };
    const prefix = `---\n${Object.entries(meta).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n`;
    files.set(file, prefix + body);
    caches.set(file, { frontmatter: meta });
    return file;
  };
  return { plugin, app, files, caches, leaves, add, ports: () => (plugin as any).ports() };
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it('skips indexed unlinked notes and reads unindexed files only once per run', async () => {
  const s = setup();
  for (let i = 0; i < 100; i++) {
    const file = fileAt(`unlinked-${i}.md`);
    s.files.set(file, 'ordinary text'); s.caches.set(file, {});
  }
  s.files.set(fileAt('unindexed.md'), 'ordinary text');
  const ports = await s.ports();
  expect(await ports.getLocal('one')).toBeNull();
  expect(await ports.getLocal('two')).toBeNull();
  expect(s.app.vault.read).toHaveBeenCalledTimes(1);
});

it('rejects duplicate linked files', async () => {
  const s = setup(); s.add('one'); s.add('one');
  await expect((await s.ports()).getLocal('one')).rejects.toThrow('Duplicate');
});

it('defers reading a note with unsaved editor content', async () => {
  const s = setup(); const file = s.add('one');
  const view = new MarkdownView({} as any); view.file = file;
  view.editor = { getValue: () => s.files.get(file)! + 'typing' } as any;
  s.leaves.push({ view });
  await expect((await s.ports()).getLocal('one')).rejects.toThrow('Local edit pending');
});

it('checks unsaved typing again inside the atomic disk replacement', async () => {
  const s = setup(); const file = s.add('one'); const disk = s.files.get(file)!;
  const view = new MarkdownView({} as any); view.file = file;
  view.editor = { getValue: () => disk } as any; s.leaves.push({ view });
  const ports = await s.ports(); expect((await ports.getLocal('one')).body).toBe('base');
  s.app.vault.process.mockImplementation(async (file, update) => {
    view.editor = { getValue: () => disk + 'typing' } as any;
    return s.files.set(file, update(s.files.get(file)!));
  });
  expect(await ports.replaceLocal('one', 'base', 'remote')).toBe(false);
  expect(s.files.get(file)).toBe(disk);
});

it('preserves frontmatter when replacing a saved note', async () => {
  const s = setup(); const file = s.add('one'); const prefix = splitFile(s.files.get(file)!).prefix;
  expect(await (await s.ports()).replaceLocal('one', 'base', 'remote')).toBe(true);
  expect(s.files.get(file)).toBe(prefix + 'remote');
});

it('imports a visible filename without title control characters', async () => {
  const s = setup();
  await (await s.ports()).createLocal({ id: 'one', title: '.hidden\n\u0000', body: 'content' });
  expect(s.app.vault.create.mock.calls[0][0]).toBe('Prismical/hidden-- - one.md');
  expect(safeTitle('...')).toBe('Note');
});

it('throttles focus-triggered runs while allowing explicit manual sync', async () => {
  vi.useFakeTimers(); const s = setup();
  await s.plugin.run(); await s.plugin.run();
  expect(requestUrl).toHaveBeenCalledTimes(1);
  await s.plugin.run(true); expect(requestUrl).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(30_000); await s.plugin.run();
  expect(requestUrl).toHaveBeenCalledTimes(3);
});

it('honors retry-after on automatic runs', async () => {
  vi.useFakeTimers(); const s = setup();
  vi.mocked(requestUrl).mockResolvedValue({ status: 429, headers: { 'retry-after': '120' }, text: '{}' } as any);
  await s.plugin.run(); vi.advanceTimersByTime(60_000); await s.plugin.run();
  expect(requestUrl).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(60_000); await s.plugin.run(); expect(requestUrl).toHaveBeenCalledTimes(2);
});

it('debounces draft settings and pauses new runs while typing', async () => {
  vi.useFakeTimers(); const s = setup();
  s.plugin.queueSettings({ api: 'h' }); s.plugin.queueSettings({ api: 'https://api.prismical.ai', noteIds: 'one' });
  await s.plugin.run(); expect(requestUrl).not.toHaveBeenCalled();
  expect(s.plugin.settings.noteIds).toBe('');
  await vi.advanceTimersByTimeAsync(600);
  expect(s.plugin.settings.noteIds).toBe('one');
  expect(s.plugin.saveData).toHaveBeenCalledTimes(1);
});

it('reports a malformed identity response clearly', async () => {
  const s = setup(); vi.mocked(requestUrl).mockResolvedValue({ status: 200, text: 'not json', headers: {} } as any);
  await expect(s.ports()).rejects.toThrow('Invalid account response');
});

it('locks review initialization against background sync and allows paused inspection', async () => {
  const s = setup();
  let finish!: (value: any) => void;
  vi.mocked(requestUrl).mockImplementation(() => new Promise(resolve => { finish = resolve; }) as any);
  const review = s.plugin.review(); await s.plugin.run();
  expect(requestUrl).toHaveBeenCalledTimes(1);
  finish({ status: 200, headers: {}, text: JSON.stringify({ org_user_id: 'user', org: { id: 'org' } }) });
  await review;
  s.plugin.settings.enabled = false;
  vi.mocked(requestUrl).mockResolvedValue({ status: 200, headers: {}, text: JSON.stringify({ org_user_id: 'user', org: { id: 'org' } }) } as any);
  await s.plugin.review(); expect(requestUrl).toHaveBeenCalledTimes(2);
});
