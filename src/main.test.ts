import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { MarkdownView, requestUrl, TFile } from 'obsidian';
import { syncNote, syncNotes } from './engine';
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


it.each([{}, { frontmatterPosition: { start: { line: 0 }, end: { line: 5 } } }])(
  'retains a malformed linked file and resumes after repair with cache %j', async cache => {
    const s = setup(); const file = s.add('one'); const original = s.files.get(file)!;
    s.files.set(file, original.replace('---\nbase', 'tags: [foo\n---\nbase'));
    s.caches.set(file, cache);
    const ports = await s.ports();
    ports.getRemote = async () => ({ id: 'one', title: 'Note', body: 'remote', sync_revision: 'a'.repeat(64), sync_problem: null, can_write: true, trashed_at: null });
    const baseline = { base: 'base', path: file.path };
    await ports.save('one', baseline);
    await expect(syncNote('one', ports)).rejects.toThrow('repair the YAML');
    expect(await ports.load('one')).toEqual(baseline);
    s.files.set(file, original);
    // The cache may still be missing parsed properties immediately after repair.
    expect(await syncNote('one', ports)).toBe('Up to date');
    expect((await ports.load('one')).base).toBe('remote');
    expect(s.files.get(file)).toBe(original.replace('---\nbase', '---\nremote'));
  }
);

it.each(['ordinary text', '---\nprismical_note_id: "other"\n---\nbase'])(
  'does not infer deletion from missing or changed identity properties: %s', async text => {
    const s = setup(); const file = s.add('one'); s.files.set(file, text); s.caches.set(file, {});
    const ports = await s.ports();
    await ports.save('one', { base: 'base', path: file.path });
    await expect(ports.getLocal('one')).rejects.toThrow('still exists');
    expect((await ports.load('one')).excluded).toBeUndefined();
  }
);

it('still disconnects after confirmed local removal', async () => {
  const s = setup(); const file = s.add('one'); s.files.delete(file);
  const ports = await s.ports();
  await ports.save('one', { base: 'base', path: file.path });
  ports.getRemote = async () => ({ id: 'one', title: 'Note', body: 'base', sync_revision: 'a'.repeat(64), sync_problem: null, can_write: true, trashed_at: null });
  expect(await syncNote('one', ports)).toBe('Disconnected after local removal');
});

it('finds a moved linked note instead of disconnecting the old path', async () => {
  const s = setup(); const file = s.add('one'); file.path = 'moved.md';
  const ports = await s.ports(); await ports.save('one', { base: 'base', path: 'one.md' });
  expect(await ports.getLocal('one')).toEqual({ path: 'moved.md', body: 'base' });
});

it('continues syncing healthy notes when another linked file has malformed YAML', async () => {
  const s = setup(); const broken = s.add('one'); const healthy = s.add('two');
  s.files.set(broken, s.files.get(broken)!.replace('---\nbase', 'tags: [foo\n---\nbase'));
  s.caches.set(broken, {});
  const ports = await s.ports();
  await ports.save('one', { base: 'base', path: broken.path });
  await ports.save('two', { base: 'base', path: healthy.path });
  ports.getRemote = async (id: string) => ({ id, title: 'Note', body: 'remote', sync_revision: 'a'.repeat(64), sync_problem: null, can_write: true, trashed_at: null });
  const report = vi.fn(); await syncNotes(['one', 'two'], ports, report);
  expect(report).toHaveBeenCalledWith('one', expect.stringContaining('repair the YAML'));
  expect(report).toHaveBeenCalledWith('two', 'Up to date');
  expect((await ports.load('one')).excluded).toBeUndefined();
});

it('rejects a moved malformed linked file identified by a frontmatter position', async () => {
  const s = setup(); const file = s.add('one'); file.path = 'moved.md';
  s.files.set(file, s.files.get(file)!.replace('---\nbase', 'tags: [foo\n---\nbase'));
  s.caches.set(file, { frontmatterPosition: { start: { line: 0 }, end: { line: 5 } } });
  const ports = await s.ports(); await ports.save('one', { base: 'base', path: 'one.md' });
  await expect(ports.getLocal('one')).rejects.toThrow('repair the YAML');
  expect((await ports.load('one')).excluded).toBeUndefined();
});

it('refuses content whose identity changes after discovery', async () => {
  const s = setup(); const file = s.add('one'); const original = s.files.get(file)!;
  const ports = await s.ports();
  s.app.vault.read.mockResolvedValueOnce(original).mockResolvedValueOnce(original.replace('"one"', '"other"'));
  await expect(ports.getLocal('one')).rejects.toThrow('properties changed during sync');
});


it('identifies the plugin and correlates existing API requests per sync run', async () => {
  const s = setup();
  const ports = await s.ports();
  await expect(ports.getRemote('one')).rejects.toThrow();
  const requests = vi.mocked(requestUrl).mock.calls.map(([request]) => request as { headers: Record<string, string> });
  expect(requests).toHaveLength(2);
  expect(requests[0].headers).toMatchObject({ 'X-Prismical-Client': 'obsidian', 'X-Prismical-Client-Version': '0.1.0' });
  expect(requests[0].headers['X-Prismical-Sync-Id']).toMatch(/^[a-f0-9-]{36}$/);
  expect(requests[1].headers['X-Prismical-Sync-Id']).toBe(requests[0].headers['X-Prismical-Sync-Id']);
  await s.ports();
  const next = vi.mocked(requestUrl).mock.calls[2][0] as { headers: Record<string, string> };
  expect(next.headers['X-Prismical-Sync-Id']).not.toBe(requests[0].headers['X-Prismical-Sync-Id']);
});

function discoveryApi(notes: Record<string, any>, folderRows: any[] = []) {
  vi.mocked(requestUrl).mockImplementation(((async (request: any) => {
    const url = new URL(request.url);
    let data: unknown;
    if (url.pathname === '/v1/whoami') data = { org_user_id: 'user', org: { id: 'org' } };
    else if (url.pathname === '/v1/folders') data = { results: folderRows, has_more: false };
    else if (url.pathname === '/v1/notes') data = { results: Object.values(notes).map(n => ({ ...n, updated_at: '2026-10-07T00:00:00Z' })), has_more: false };
    else data = notes[url.pathname.split('/')[3]];
    return { status: data ? 200 : 404, headers: {}, text: JSON.stringify(data ?? { error: { message: 'Not found' } }) } as any;
  }) as any));
}
const listedNote = (id: string, folder_id: string | null = null) => ({ id, title: id, body: 'base', folder_id, can_write: true, trashed_at: null, sync_problem: null, sync_revision: 'a'.repeat(64) });
it('automatically imports all notes and avoids unchanged body downloads next cycle', async () => {
  const s = setup(); s.plugin.settings.mode = 'all'; discoveryApi({ one: listedNote('one'), two: listedNote('two') });
  await s.plugin.run(true);
  expect(s.app.vault.create).toHaveBeenCalledTimes(2);
  vi.mocked(requestUrl).mockClear();
  await s.plugin.run(true);
  expect(vi.mocked(requestUrl).mock.calls.filter(([r]) => typeof r !== 'string' && r.url.includes('include_body'))).toHaveLength(0);
});
it('imports only selected subtree notes without downloading unrelated bodies', async () => {
  const s = setup(); Object.assign(s.plugin.settings, { mode: 'folders', folderIds: ['root'], descendants: true });
  discoveryApi({ one: listedNote('one','child'), other: listedNote('other'), outside: listedNote('outside','elsewhere') },
    [{id:'root',name:'Root',parent_id:null},{id:'child',name:'Child',parent_id:'root'}]);
  await s.plugin.run(true);
  expect(s.app.vault.create).toHaveBeenCalledTimes(1);
  expect(s.app.vault.create.mock.calls[0][0]).toContain('one');
  expect(vi.mocked(requestUrl).mock.calls.filter(([r]) => typeof r !== 'string' && r.url.includes('include_body'))).toHaveLength(1);
});
it('detects a folder moved into the selected subtree despite unchanged note timestamps', async () => {
  const s = setup(); Object.assign(s.plugin.settings, { mode: 'folders', folderIds: ['root'], descendants: true });
  const fs=[{id:'root',name:'Root',parent_id:null},{id:'child',name:'Child',parent_id:null as string|null}];
  discoveryApi({one:listedNote('one','child')},fs);
  await s.plugin.run(true); expect(s.app.vault.create).not.toHaveBeenCalled();
  fs[1].parent_id='root';
  await s.plugin.run(true); expect(s.app.vault.create).toHaveBeenCalledTimes(1);
});
it('preserves files and baselines when the selection changes', async () => {
  const s=setup();s.plugin.settings.mode='all';discoveryApi({one:listedNote('one')});
  await s.plugin.run(true);
  const before=await (await s.ports()).load('one');
  Object.assign(s.plugin.settings,{mode:'folders',folderIds:[]});
  await s.plugin.configure();await s.plugin.run(true);
  expect(await (await s.ports()).load('one')).toEqual(before);expect(s.files.size).toBe(1);
});
it('resumes a batch queue across plugin instances without reimporting completed files',async()=>{
  const s=setup();s.plugin.settings.mode='all';
  const ns=Object.fromEntries(Array.from({length:55},(_,i)=>[`n${i}`,listedNote(`n${i}`)]));discoveryApi(ns);
  await s.plugin.run(true);expect(s.app.vault.create).toHaveBeenCalledTimes(50);
  const next=new PrismicalSync({} as any,{} as any);next.app=s.app as any;Object.assign(next.settings,{mode:'all',enabled:true});(next as any).status={setText:vi.fn()};
  await next.run(true);expect(s.app.vault.create).toHaveBeenCalledTimes(55);
  expect(s.files.size).toBe(55);
});
