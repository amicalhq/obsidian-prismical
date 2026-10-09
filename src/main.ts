import {
  App,
  Modal,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  SecretComponent,
  Setting,
  TFile,
  normalizePath,
  parseYaml,
  requestUrl,
} from 'obsidian';
import {
  ApiError,
  resolveConflict,
  syncNotes,
  GlobalSyncError,
  StaleConflictError,
  type SyncPorts,
} from './engine';
import { StateStore } from './store';
import { validateNote } from './remote-note';
import { discover, emptyDiscovery, inScope, listFolders, selectedFolders, type DiscoveryState, type Folder, type Selection } from './discovery';
import { dateFolderSegments, importPath, renderTemplate } from './paths';
export { safeTitle } from './paths';

interface Settings extends Selection {
  api: string;
  secret: string;
  folder: string;
  dateFolderFormat: string;
  filenameTemplate: string;
  frontmatterTemplate: string;
  enabled: boolean;
}
const defaults: Settings = {
  api: 'https://api.prismical.ai',
  secret: '',
  folder: 'Prismical',
  dateFolderFormat: '',
  filenameTemplate: '{title}',
  frontmatterTemplate: 'created: {created_datetime}',
  enabled: false,
  mode: 'all',
  folderIds: [],
  descendants: true,
};
const sampleContext = {
  id: 'abc-123', title: 'Sample note', org: 'org', api: defaults.api,
  created_at: '2026-10-08T12:00:00Z', updated_at: '2026-10-08T12:00:00Z',
};
/** A saved template that would reject every note is discarded on load. */
function usable<T extends string>(value: unknown, check: (template: T) => void, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try { check(value as T); return value as T; } catch { return fallback; }
}
export function splitFile(text: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const meta = match ? parseYaml(match[1]) : {};
  return {
    prefix: match?.[0] ?? '',
    body: text.slice(match?.[0].length ?? 0),
    meta: meta && typeof meta === 'object' ? meta : {},
  };
}
function validApi(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Use an HTTPS API origin without a path');
  return url.origin;
}

export default class PrismicalSync extends Plugin {
  settings = { ...defaults };
  private running = false;
  private discovery?: DiscoveryState;
  private apiRequest?: (path: string) => Promise<any>;
  private scopeFolders = new Set<string>();
  private localSignatures = new Map<string, string>();
  private listedFolders: Folder[] = [];

  private stopped = false;
  private generation = 0;
  private store?: StateStore;
  private namespace = '';
  private status!: HTMLElement;
  private outcomes = new Map<string, string>();
  private retryAt = 0;
  private failures = 0;
  private lastAutoRun = -Infinity;
  private settingsTimer?: ReturnType<typeof setTimeout>;
  private draft: Partial<Settings> = {};

  queueSettings(patch: Partial<Settings>) {
    Object.assign(this.draft, patch);
    clearTimeout(this.settingsTimer);
    this.settingsTimer = setTimeout(() => {
      Object.assign(this.settings, this.draft);
      this.draft = {};
      this.settingsTimer = undefined;
      void this.configure();
    }, 600);
  }

  private hasUnsavedEditor(file: TFile, diskText: string) {
    return this.app.workspace.getLeavesOfType('markdown').some(({ view }) =>
      view instanceof MarkdownView && view.file?.path === file.path &&
      view.getMode() === 'source' && view.editor.getValue() !== diskText
    );
  }

  async onload() {
    const saved = await this.loadData();
    const validMode = saved?.mode === 'all' || saved?.mode === 'folders';
    this.settings = {
      api: saved?.api ?? defaults.api,
      secret: saved?.secret ?? defaults.secret,
      folder: saved?.folder ?? defaults.folder,
      dateFolderFormat: usable<string>(saved?.dateFolderFormat, t => dateFolderSegments(t, sampleContext.created_at), defaults.dateFolderFormat),
      filenameTemplate: usable<string>(saved?.filenameTemplate, t => renderTemplate(t, sampleContext), defaults.filenameTemplate),
      frontmatterTemplate: usable<string>(saved?.frontmatterTemplate, t => renderTemplate(t, sampleContext), defaults.frontmatterTemplate),
      mode: validMode ? saved.mode : defaults.mode,
      folderIds: saved?.folderIds ?? [],
      descendants: saved?.descendants ?? defaults.descendants,
      enabled: validMode && this.app.loadLocalStorage('prismical-sync-enabled') === true,
    };
    this.status = this.addStatusBarItem();
    this.status.setText('Prismical: paused');
    this.addSettingTab(new SyncSettings(this.app, this));
    this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => void this.run(true) });
    this.addCommand({
      id: 'review-sync',
      name: 'Review sync status and conflicts',
      callback: () => void this.review(),
    });
    this.addCommand({
      id: 'reorganize-files',
      name: 'Reorganize note files to the current layout',
      callback: () => void this.reorganize(),
    });
    this.registerInterval(window.setInterval(() => void this.run(), 60_000));
    this.registerDomEvent(window, 'online', () => {
      this.retryAt = 0;
      void this.run();
    });
    this.registerDomEvent(window, 'focus', () => void this.run());
    this.app.workspace.onLayoutReady(() => void this.run());
  }
  onunload() {
    clearTimeout(this.settingsTimer);
    this.stopped = true;
    this.generation++;
    void this.store?.close();
  }
  async configure() {
    this.generation++;
    this.retryAt = 0;
    this.outcomes.clear();
    this.localSignatures.clear();
    this.status.setText(this.settings.enabled ? 'Prismical: ready' : 'Prismical: paused');
    this.app.saveLocalStorage('prismical-sync-enabled', this.settings.enabled);
    const { enabled: _enabled, ...shared } = this.settings;
    await this.saveData(shared);
  }
  private async ports(review = false): Promise<SyncPorts> {
    const generation = this.generation;
    const active = () => !this.stopped && this.settings.enabled && generation === this.generation;
    const api = validApi(this.settings.api);
    const key = this.app.secretStorage.getSecret(this.settings.secret);
    if (!key) throw new Error('Choose a Prismical API key in settings');
    const syncRunId = crypto.randomUUID();
    const request = async (path: string, body?: unknown): Promise<any> => {
      if (this.stopped || generation !== this.generation || (!active() && (!review || body !== undefined)))
        throw new Error('Sync is paused or settings changed');
      const response = await requestUrl({
        url: `${api}/v1${path}`,
        method: body === undefined ? 'GET' : 'PUT',
        headers: {
          Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
          'X-Prismical-Client': 'obsidian',
          'X-Prismical-Client-Version': this.manifest.version,
          'X-Prismical-Sync-Id': syncRunId,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        throw: false,
      }).catch(error => {
        throw new GlobalSyncError(
          error instanceof Error ? error.message : 'Network request failed'
        );
      });
      let data: any;
      try {
        data = JSON.parse(response.text);
      } catch {
        data = null;
      }
      if (response.status >= 400) {
        const retry = response.headers['retry-after'];
        const wait = retry
          ? Number.isFinite(Number(retry))
            ? Number(retry) * 1000
            : Math.max(0, Date.parse(retry) - Date.now())
          : 0;
        throw new ApiError(
          response.status,
          data?.error?.message ?? `HTTP ${response.status}`,
          wait
        );
      }
      return data;
    };
    const who = await request('/whoami');
    if (this.stopped || generation !== this.generation) throw new Error('Settings changed; retry sync');
    if (!who || typeof who.org_user_id !== 'string' || typeof who.org?.id !== 'string')
      throw new Error('Invalid account response');
    // Obsidian local storage is scoped to this vault; the marker does not live in synced files.
    let vaultId = this.app.loadLocalStorage('prismical-sync-vault-id') as string | null;
    if (!vaultId) {
      vaultId = crypto.randomUUID();
      this.app.saveLocalStorage('prismical-sync-vault-id', vaultId);
    }
    const namespace = `${vaultId}:${api}:${who.org_user_id}`;
    if (namespace !== this.namespace) {
      await this.store?.close();
      this.store = new StateStore(namespace);
      this.namespace = namespace;
      this.localSignatures.clear();
      this.outcomes.clear();
    }
    const store = this.store!;
    this.apiRequest = request;
    if (review && this.settings.mode === 'folders') {
      this.listedFolders = await listFolders(request);
      this.scopeFolders = selectedFolders(this.settings, this.listedFolders);
    }
    this.discovery = await store.loadDiscovery<DiscoveryState>();

    const unindexed = new Map<string, string>();
    const index = new Map<string, TFile[]>();
    const uncertain: TFile[] = [];
    const malformed: TFile[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      const id = cache?.frontmatter?.prismical_note_id;
      if (typeof id === 'string') index.set(id, [...(index.get(id) ?? []), file]);
      else if (!cache || cache.frontmatterPosition) uncertain.push(file);
    }
    let scanned = false;
    const matches = async (id: string): Promise<TFile[]> => {
      const found: TFile[] = [];
      const knownPath = (await store.load(id)).path;
      if (!scanned) {
        scanned = true;
        for (const file of uncertain) {
          const text = await this.app.vault.read(file);
          unindexed.set(file.path, text);
          try {
            const id = splitFile(text).meta.prismical_note_id;
            if (typeof id === 'string') index.set(id, [...(index.get(id) ?? []), file]);
          } catch { malformed.push(file); }
        }
      }
      const known = knownPath ? this.app.vault.getAbstractFileByPath(knownPath) : null;
      const candidates = new Set([...(index.get(id) ?? []), ...malformed.filter(file => unindexed.get(file.path)?.includes(id)), ...(known instanceof TFile ? [known] : [])]);
      for (const file of candidates) {
        const cache = this.app.metadataCache.getFileCache(file);
        const cached = cache?.frontmatter;
        const knownFile = file.path === knownPath;
        const unparsedProperties = !cached && cache?.frontmatterPosition;
        if (cache && cached?.prismical_note_id !== id && !knownFile && !unparsedProperties) continue;
        const text = !knownFile && !cache && unindexed.has(file.path)
          ? unindexed.get(file.path)! : await this.app.vault.read(file);
        if (!cache) unindexed.set(file.path, text);
        let meta;
        try {
          meta = splitFile(text).meta;
        } catch (error) {
          if (knownFile || cached?.prismical_note_id === id || text.includes(id))
            throw new Error('Linked note properties could not be parsed; repair the YAML to resume sync');
          continue;
        }
        if (
          meta.prismical_note_id === id &&
          meta.prismical_org_id === who.org.id &&
          meta.prismical_api === api
        )
          found.push(file);
      }
      if (found.length > 1)
        throw new Error('Duplicate linked files: remove the Prismical ID from the extra copy');
      return found;
    };
    return {
      active,
      getRemote: async id => {
        let raw;
        try { raw = await request(`/notes/${encodeURIComponent(id)}?include_body=1`); }
        catch (error) {
          if (error instanceof ApiError && (error.status === 403 || error.status === 404))
            throw new ApiError(error.status, 'Unavailable in Prismical; local copy retained');
          throw error;
        }
        const note = validateNote(raw, id);
        if (!inScope({ folder_id: raw.folder_id, trashed_at: note.trashed_at }, this.settings, this.scopeFolders))
          throw new ApiError(403, 'Outside selection or unavailable; local copy retained');
        return note;
      },
      putRemote: async (id, body, revision) =>
        validateNote(
          await request(`/notes/${encodeURIComponent(id)}/content`, {
            markdown: body,
            mode: 'replace',
            expected_revision: revision,
          }),
          id
        ),
      load: id => store.load(id),
      save: (id, state) => store.save(id, state),
      getLocal: async id => {
        const [file] = await matches(id);
        if (!file) {
          const state = await store.load(id);
          if (state.path && this.app.vault.getAbstractFileByPath(state.path))
            throw new Error('Linked file still exists but its identity properties are missing or changed; repair them to resume sync');
          return null;
        }
        const text = await this.app.vault.read(file);
        if (this.hasUnsavedEditor(file, text)) throw new Error('Local edit pending');
        const parsed = splitFile(text);
        if (parsed.meta.prismical_note_id !== id || parsed.meta.prismical_org_id !== who.org.id || parsed.meta.prismical_api !== api)
          throw new Error('Linked note properties changed during sync; retry after repairing them');
        return { path: file.path, body: parsed.body };
      },
      createLocal: async note => {
        if (!active()) throw new Error('Sync is paused');
        const layout = importPath(this.settings, {
          id: note.id, title: note.title, org: who.org.id, api,
          created_at: note.created_at, updated_at: note.updated_at,
        });
        let parent = '';
        for (const part of layout.folder.split('/')) {
          parent = parent ? `${parent}/${part}` : part;
          if (!this.app.vault.getAbstractFileByPath(parent))
            await this.app.vault.createFolder(parent);
        }
        let path = normalizePath(layout.path);
        if (this.app.vault.getAbstractFileByPath(path) && !layout.name.endsWith(note.id)) {
          // A different note already owns this templated name; keep both by appending the note ID.
          const fallback = normalizePath(`${layout.folder}/${layout.name} - ${note.id}.md`);
          if (!this.app.vault.getAbstractFileByPath(fallback)) path = fallback;
        }
        if (this.app.vault.getAbstractFileByPath(path))
          throw new Error('Import path exists; move the unrelated file first');
        const text = `---\nprismical_note_id: ${JSON.stringify(note.id)}\nprismical_org_id: ${JSON.stringify(who.org.id)}\nprismical_api: ${JSON.stringify(api)}\nprismical_title: ${JSON.stringify(note.title)}\n${layout.frontmatter}---\n${note.body}`;
        if (!active()) throw new Error('Sync is paused');
        await this.app.vault.create(path, text);
        unindexed.set(path, text);
        const created = this.app.vault.getAbstractFileByPath(path);
        if (created instanceof TFile) index.set(note.id, [...(index.get(note.id) ?? []), created]);
        return { path, body: note.body };
      },
      replaceLocal: async (id, expected, body) => {
        if (!active()) return false;
        const [file] = await matches(id);
        if (!file) return false;
        let applied = false;
        await this.app.vault.process(file, text => {
          const parsed = splitFile(text);
          if (
            !active() ||
            this.hasUnsavedEditor(file, text) ||
            parsed.body !== expected ||
            parsed.meta.prismical_note_id !== id ||
            parsed.meta.prismical_org_id !== who.org.id ||
            parsed.meta.prismical_api !== api
          )
            return text;
          applied = true;
          unindexed.set(file.path, parsed.prefix + body);
          return parsed.prefix + body;
        });
        return applied;
      },
    };
  }
  async run(manual = false) {
    if (this.running || this.stopped || !this.settings.enabled || this.settingsTimer) return;
    if (!manual && (Date.now() < this.retryAt || Date.now() - this.lastAutoRun < 30_000)) return;
    this.lastAutoRun = Date.now();
    this.running = true;
    this.status.setText('Prismical: syncing');
    try {
      const ports = await this.ports();
      await this.runDiscovery(ports);
      this.failures = 0;
      const attention = [...this.outcomes.values()].some(
        value => value !== 'Up to date' && value !== 'Disconnected'
      );
      this.status.setText(attention ? 'Prismical: review needed' : this.discovery?.pass || this.discovery?.queue.length ? 'Prismical: syncing in batches' : 'Prismical: up to date');
    } catch (error) {
      this.failures++;
      this.retryAt =
        Date.now() +
        Math.max(
          error instanceof ApiError ? error.retryAfterMs : 0,
          Math.min(300_000, 5000 * 2 ** this.failures) + Math.random() * 1000
        );
      if (error instanceof ApiError && error.status === 401)
        this.retryAt = Number.POSITIVE_INFINITY;
      this.status.setText(
        `Prismical: ${error instanceof Error ? error.message : 'offline; changes retained'}`
      );
      if (manual) new Notice(this.status.textContent ?? 'Sync failed');
    } finally {
      this.running = false;
    }
  }
  async folders(): Promise<Folder[]> {
    if (this.running) throw new Error('Wait for the current sync to finish');
    this.running = true;
    try {
      await this.ports(true);
      this.listedFolders = await listFolders(this.apiRequest!);
      return this.listedFolders;
    } finally { this.running = false; }
  }
  async reorganize() {
    if (this.running) {
      new Notice('Wait for the current sync to finish');
      return;
    }
    this.running = true;
    const generation = this.generation;
    try {
      await this.ports(true);
      const state = this.discovery;
      if (!state) throw new Error('Sync at least once before reorganizing');
      let moved = 0, skipped = 0, errors: string[] = [];
      for (const entry of Object.values(state.entries)) {
        if (generation !== this.generation) throw new Error('Settings changed; retry reorganize');
        if (!inScope(entry, this.settings, this.scopeFolders)) continue;
        const checkpoint = await this.store!.load(entry.id);
        if (checkpoint.excluded) continue;
        const file = checkpoint.path ? this.app.vault.getAbstractFileByPath(checkpoint.path) : null;
        if (!(file instanceof TFile)) continue;
        let layout;
        try {
          layout = importPath(this.settings, {
            id: entry.id, title: entry.title, org: '', api: this.settings.api,
            // Legacy discovery checkpoints predate created_at; fall back to updated_at.
            created_at: entry.created_at ?? entry.updated_at, updated_at: entry.updated_at,
          });
        } catch (error) {
          errors.push(`${entry.title}: ${error instanceof Error ? error.message : 'invalid layout'}`);
          continue;
        }
        const target = normalizePath(layout.path);
        if (file.path === target) continue;
        if (this.app.vault.getAbstractFileByPath(target)) {
          skipped++; continue;
        }
        await this.app.vault.createFolder(layout.folder);
        await this.app.vault.rename(file, target);
        await this.store!.save(entry.id, { ...checkpoint, path: target });
        moved++;
      }
      const summary = `${moved} note${moved === 1 ? '' : 's'} moved${skipped ? `, ${skipped} skipped (target exists)` : ''}`;
      new Notice(errors.length ? `${summary}; ${errors.length} failed: ${errors[0]}` : summary);
      if (errors.length) this.status.setText(`Prismical: ${errors.length} reorganize failures`);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : 'Reorganize failed');
    } finally { this.running = false; }
  }
  private async runDiscovery(ports: SyncPorts) {
    const selection = structuredClone(this.settings);
    const scope = JSON.stringify([selection.mode, [...selection.folderIds].sort(), selection.descendants]);
    let state = this.discovery;
    if (!state || state.scope !== scope) state = emptyDiscovery(scope);
    if (selection.mode === 'folders') {
      this.listedFolders = await listFolders(this.apiRequest!);
      this.scopeFolders = selectedFolders(selection, this.listedFolders);
    }
    state = await discover(state, this.apiRequest!, Date.now());
    if (!ports.active()) return;
    const pending = new Set(state.queue);
    const dirty = new Set<string>();
    if (selection.mode === 'folders') {
      const previous = new Set(state.folderScope ?? []);
      for (const entry of Object.values(state.entries))
        if (entry.folder_id && this.scopeFolders.has(entry.folder_id) && !previous.has(entry.folder_id)) pending.add(entry.id);
      state.folderScope = [...this.scopeFolders];
    }
    // Metadata scan is linear in vault size; unchanged file bodies are not reread.
    for (const file of this.app.vault.getMarkdownFiles()) {
      const meta = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const id = meta?.prismical_note_id;
      if (typeof id !== 'string' || !state.entries[id] || meta?.prismical_api !== selection.api) continue;
      const signature = `${file.path}:${file.stat?.mtime}:${file.stat?.size}`;
      if (this.localSignatures.get(id) !== signature) {
        try {
          const local = await ports.getLocal(id); const saved = await ports.load(id);
          if (saved.pending || saved.conflict || local?.body !== saved.base) dirty.add(id);
          this.localSignatures.set(id, signature);
        } catch { dirty.add(id); }
      }
    }
    state.queue = [...new Set([...dirty, ...pending])].filter(id => {
      const entry = state!.entries[id];
      if (entry && !inScope(entry, selection, this.scopeFolders)) {
        if (this.localSignatures.has(id)) this.outcomes.set(id, 'Outside selection; local copy retained');
        return false;
      }
      return true;
    });
    this.discovery = state;
    await this.store!.saveDiscovery(state);
    const batch = state.queue.slice(0, 50);
    for (const id of batch) {
      if (!ports.active()) break;
      await syncNotes([id], ports, (noteId, outcome) => this.outcomes.set(noteId, outcome));
      const outcome = this.outcomes.get(id);
      state.queue = state.queue.filter(x => x !== id);
      // Per-note failures rotate to the end; failures must not starve later notes.
      if (outcome !== 'Up to date' && outcome !== 'Disconnected' && outcome !== 'Disconnected after local removal' &&
          !outcome?.includes('Outside selection') && outcome !== 'Conflict needs review' && outcome !== 'Unavailable in Prismical; local copy retained') state.queue.push(id);
    }
    await this.store!.saveDiscovery(state);
  }
  async review(offset = 0) {
    if (this.running) {
      new Notice('Wait for the current sync to finish');
      return;
    }
    this.running = true;
    const generation = this.generation;
    try {
      const ports = await this.ports(true);
      const modal = new Modal(this.app);
      modal.setTitle('Prismical sync');
      const ids = Object.values(this.discovery?.entries ?? {})
        .filter(entry => inScope(entry, this.settings, this.scopeFolders) || this.outcomes.has(entry.id)).map(entry => entry.id);
      modal.contentEl.createEl('p', { text: `${ids.length} notes. Showing ${Math.min(offset + 1, ids.length)}–${Math.min(offset + 100, ids.length)}.` });
      for (const id of ids.slice(offset, offset + 100)) {
        const state = await ports.load(id);
        modal.contentEl.createEl('h3', { text: this.discovery?.entries[id]?.title ?? id });
        modal.contentEl.createEl('p', { text: this.outcomes.get(id) ?? 'Not synchronized yet' });
        if (state.conflict) {
          modal.contentEl.createEl('p', { text: state.conflict.reason });
          modal.contentEl.createEl('h4', { text: 'Obsidian version' });
          modal.contentEl.createEl('pre', { text: state.conflict.local });
          modal.contentEl.createEl('h4', { text: 'Prismical version' });
          modal.contentEl.createEl('pre', { text: state.conflict.remote });
          for (const choice of ['local', 'remote'] as const) {
            new Setting(modal.contentEl)
              .setName(choice === 'local' ? 'Use Obsidian version' : 'Use Prismical version')
              .addButton(button =>
                button.setButtonText('Use this version').onClick(async () => {
                  if (this.running) {
                    new Notice('Wait for the current sync to finish');
                    return;
                  }
                  this.running = true;
                  let refresh = false;
                  try {
                    if (generation !== this.generation) throw new Error('Settings changed; reopen review');
                    const currentPorts = await this.ports();
                    await resolveConflict(id, choice, currentPorts, state.conflict!, async conflict => {
                      await this.app.vault.create(
                        `Prismical conflict ${id} ${Date.now()}.md`,
                        `# Obsidian version\n\n${conflict.local}\n\n# Prismical version\n\n${conflict.remote}`
                      );
                    });
                    modal.close();
                    new Notice('Conflict resolved; both originals saved');
                  } catch (error) {
                    refresh = error instanceof StaleConflictError;
                    new Notice(String(error));
                  } finally {
                    this.running = false;
                  }
                  if (refresh) {
                    modal.close();
                    await this.review();
                  }
                })
              );
          }
        }
        new Setting(modal.contentEl)
          .setName(state.excluded ? 'Reconnect note' : 'Disconnect note')
          .addButton(button =>
            button.setButtonText(state.excluded ? 'Reconnect' : 'Disconnect').onClick(async () => {
              if (this.running) {
                new Notice('Wait for the current sync to finish');
                return;
              }
              this.running = true;
              try {
                if (generation !== this.generation) throw new Error('Settings changed; reopen review');
                const currentPorts = await this.ports(true);
                const current = await currentPorts.load(id);
                await currentPorts.save(id, { ...current, excluded: !state.excluded });
                if (state.excluded && this.discovery) {
                  this.discovery.queue = [...new Set([id, ...this.discovery.queue])];
                  await this.store!.saveDiscovery(this.discovery);
                }
                modal.close();
              } catch (error) {
                new Notice(String(error));
              } finally {
                this.running = false;
              }
            })
          );
      }
      if (offset + 100 < ids.length) new Setting(modal.contentEl).addButton(button =>
        button.setButtonText('Next 100 notes').onClick(() => { modal.close(); void this.review(offset + 100); }));
      if (offset > 0) new Setting(modal.contentEl).addButton(button =>
        button.setButtonText('Previous 100 notes').onClick(() => { modal.close(); void this.review(Math.max(0, offset - 100)); }));
      modal.open();
    } catch (error) {
      new Notice(String(error));
    } finally {
      this.running = false;
    }
  }
}

class SyncSettings extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: PrismicalSync
  ) {
    super(app, plugin);
  }
  display() {
    this.containerEl.empty();
    this.containerEl.createEl('p', {
      text: 'Two-way note bodies. Use one connector device per shared vault. API keys access your authorized workspace, not only the selected notes.',
    });
    new Setting(this.containerEl).setName('Enable sync on this device').addToggle(toggle =>
      toggle.setValue(this.plugin.settings.enabled).onChange(async value => {
        this.plugin.settings.enabled = value;
        await this.plugin.configure();
      })
    );
    new Setting(this.containerEl).setName('Prismical API key').addComponent(el =>
      new SecretComponent(this.app, el)
        .setValue(this.plugin.settings.secret)
        .onChange(async value => {
          this.plugin.settings.secret = value;
          await this.plugin.configure();
        })
    );
    new Setting(this.containerEl)
      .setName('API origin')
      .setDesc('HTTPS origin of the Prismical API')
      .addText(text =>
        text.setValue(this.plugin.settings.api).onChange(async value => {
          this.plugin.queueSettings({ api: value });
        })
      );
    new Setting(this.containerEl).setName('Sync selection').addDropdown(dropdown =>
      dropdown.addOption('all', 'All notes').addOption('folders', 'Selected folders')
        .setValue(this.plugin.settings.mode).onChange(async mode => {
          this.plugin.settings.mode = mode as Selection['mode'];
          await this.plugin.configure(); this.display();
        })
    );
    if (this.plugin.settings.mode === 'folders') {
      new Setting(this.containerEl).setName('Include subfolders').addToggle(toggle =>
        toggle.setValue(this.plugin.settings.descendants).onChange(async value => { this.plugin.settings.descendants = value; await this.plugin.configure(); }));
      const choices = this.containerEl.createDiv();
      new Setting(choices).setName('Prismical folders').setDesc('Select one or more folders. A top-level folder includes only its subtree; All notes also includes unfiled notes.')
        .addButton(button => button.setButtonText('Choose folders').onClick(async () => {
          try {
            const folders = await this.plugin.folders();
            const labels = new Map(folders.map(f => [f.id, f.name]));
            choices.empty();
            for (const folder of folders) new Setting(choices)
              .setName((folder.parent_id ? (labels.get(folder.parent_id) ?? 'Shared folder') + ' / ' : '') + folder.name)
              .addToggle(toggle => toggle.setValue(this.plugin.settings.folderIds.includes(folder.id)).onChange(async value => {
                this.plugin.settings.folderIds = value ? [...new Set([...this.plugin.settings.folderIds, folder.id])] : this.plugin.settings.folderIds.filter(id => id !== folder.id);
                await this.plugin.configure();
              }));
            if (!folders.length) choices.createEl('p', { text: 'No accessible folders found.' });
          } catch (error) { new Notice(String(error)); }
        }));
    }
    new Setting(this.containerEl).setName('Destination folder').addText(text =>
      text.setValue(this.plugin.settings.folder).onChange(async value => {
        this.plugin.queueSettings({ folder: value });
      })
    );
    const preview = this.containerEl.createDiv();
    preview.createEl('p', { cls: 'text-small text-muted' });
    const showPreview = (patch: Partial<typeof this.plugin.settings>) => {
      preview.empty();
      const line = preview.createEl('p', { cls: 'text-small text-muted' });
      try {
        const layout = importPath({ ...this.plugin.settings, ...patch }, sampleContext);
        line.setText(`Example: ${layout.path}${layout.frontmatter ? ` + frontmatter` : ''}`);
      } catch (error) {
        line.setText(`Invalid: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    };
    new Setting(this.containerEl)
      .setName('Date folder format')
      .setDesc('Optional subfolders under the destination from the note creation date, e.g. YYYY or YYYY/Q for 2026/Q4. Leave empty for a flat folder.')
      .addText(text =>
        text.setValue(this.plugin.settings.dateFolderFormat)
          .onChange(value => { this.plugin.queueSettings({ dateFolderFormat: value }); showPreview({ dateFolderFormat: value }); })
      );
    new Setting(this.containerEl)
      .setName('Filename template')
      .setDesc('Names the file; {title} {id} {created_date} {updated_date} {created_time} {updated_time} {created_datetime} {updated_datetime}, with a date format after a colon. For recurring meetings use {created_date:YYYY/MM/DD} - {title} so each occurrence is unique.')
      .addText(text =>
        text.setValue(this.plugin.settings.filenameTemplate)
          .onChange(value => { this.plugin.queueSettings({ filenameTemplate: value }); showPreview({ filenameTemplate: value }); })
      );
    new Setting(this.containerEl)
      .setName('Frontmatter template')
      .setDesc('Extra vault-only properties, one per line, rendered once at import, e.g. created: {created_date:YYYY-MM-DD}. Add as many custom keys as you like; never sent to Prismical.')
      .addTextArea(text =>
        text.setPlaceholder('date: {created_date:YYYY-MM-DD}\nsource: prismical')
          .setValue(this.plugin.settings.frontmatterTemplate)
          .onChange(value => { this.plugin.queueSettings({ frontmatterTemplate: value }); showPreview({ frontmatterTemplate: value }); })
      );
    new Setting(this.containerEl)
      .addButton(button => button.setButtonText('Sync now').onClick(() => this.plugin.run(true)))
      .addButton(button => button.setButtonText('Review').onClick(() => this.plugin.review()))
      .addButton(button => button.setButtonText('Reorganize').onClick(() => this.plugin.reorganize()));
  }
}
