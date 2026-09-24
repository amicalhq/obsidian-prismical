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

interface Settings {
  api: string;
  secret: string;
  noteIds: string;
  folder: string;
  enabled: boolean;
}
const defaults: Settings = {
  api: 'https://api.prismical.ai',
  secret: '',
  noteIds: '',
  folder: 'Prismical',
  enabled: false,
};
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

export function safeTitle(title: string): string {
  return title.replace(/[\x00-\x1f\x7f\\/:*?"<>|\[\]#^]/g, '-')
    .replace(/^[. ]+/g, '').slice(0, 80).replace(/[. ]+$/g, '') || 'Note';
}

export default class PrismicalSync extends Plugin {
  settings = { ...defaults };
  private running = false;
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
    this.settings = { ...defaults, ...(await this.loadData()) };
    this.settings.enabled = this.app.loadLocalStorage('prismical-sync-enabled') === true;
    this.status = this.addStatusBarItem();
    this.status.setText('Prismical: paused');
    this.addSettingTab(new SyncSettings(this.app, this));
    this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => void this.run(true) });
    this.addCommand({
      id: 'review-sync',
      name: 'Review sync status and conflicts',
      callback: () => void this.review(),
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
    this.status.setText(this.settings.enabled ? 'Prismical: ready' : 'Prismical: paused');
    this.app.saveLocalStorage('prismical-sync-enabled', this.settings.enabled);
    const { enabled: _enabled, ...shared } = this.settings;
    await this.saveData(shared);
  }
  ids() {
    const ids = [...new Set(this.settings.noteIds.split(/[\s,]+/).filter(Boolean))];
    if (ids.length > 50 || ids.some(id => !/^[\w-]{1,160}$/.test(id)))
      throw new Error('Select up to 50 valid note IDs');
    return ids;
  }
  private async ports(review = false): Promise<SyncPorts> {
    const generation = this.generation;
    const active = () => !this.stopped && this.settings.enabled && generation === this.generation;
    const api = validApi(this.settings.api);
    const key = this.app.secretStorage.getSecret(this.settings.secret);
    if (!key) throw new Error('Choose a Prismical API key in settings');
    const request = async (path: string, body?: unknown): Promise<any> => {
      if (this.stopped || generation !== this.generation || (!active() && (!review || body !== undefined)))
        throw new Error('Sync is paused or settings changed');
      const response = await requestUrl({
        url: `${api}/v1${path}`,
        method: body === undefined ? 'GET' : 'PUT',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
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
    }
    const store = this.store!;
    const unindexed = new Map<string, string>();
    const matches = async (id: string): Promise<TFile[]> => {
      const found: TFile[] = [];
      const knownPath = (await store.load(id)).path;
      for (const file of this.app.vault.getMarkdownFiles()) {
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
      getRemote: async id =>
        validateNote(await request(`/notes/${encodeURIComponent(id)}?include_body=1`), id),
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
        const folder = normalizePath(this.settings.folder.trim());
        if (!folder || folder.split('/').some(part => part === '..' || part.startsWith('.')))
          throw new Error('Choose a visible destination folder');
        let parent = '';
        for (const part of folder.split('/')) {
          parent = parent ? `${parent}/${part}` : part;
          if (!this.app.vault.getAbstractFileByPath(parent))
            await this.app.vault.createFolder(parent);
        }
        const name = safeTitle(note.title);
        const path = normalizePath(`${folder}/${name} - ${note.id}.md`);
        if (this.app.vault.getAbstractFileByPath(path))
          throw new Error('Import path exists; move the unrelated file first');
        const text = `---\nprismical_note_id: ${JSON.stringify(note.id)}\nprismical_org_id: ${JSON.stringify(who.org.id)}\nprismical_api: ${JSON.stringify(api)}\nprismical_title: ${JSON.stringify(note.title)}\n---\n${note.body}`;
        if (!active()) throw new Error('Sync is paused');
        await this.app.vault.create(path, text);
        unindexed.set(path, text);
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
      await syncNotes(this.ids(), ports, (id, outcome) => this.outcomes.set(id, outcome));
      this.failures = 0;
      const attention = [...this.outcomes.values()].some(
        value => value !== 'Up to date' && value !== 'Disconnected'
      );
      this.status.setText(attention ? 'Prismical: review needed' : 'Prismical: up to date');
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
  async review() {
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
      for (const id of this.ids()) {
        const state = await ports.load(id);
        modal.contentEl.createEl('h3', { text: id });
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
                await currentPorts.save(id, state.excluded ? {} : { ...current, excluded: true });
                modal.close();
              } catch (error) {
                new Notice(String(error));
              } finally {
                this.running = false;
              }
            })
          );
      }
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
    new Setting(this.containerEl)
      .setName('Note IDs')
      .setDesc(
        'Up to 50 IDs, separated by commas or newlines. Copy each ID from its Prismical note URL.'
      )
      .addTextArea(text =>
        text.setValue(this.plugin.settings.noteIds).onChange(async value => {
          this.plugin.queueSettings({ noteIds: value });
        })
      );
    new Setting(this.containerEl).setName('Destination folder').addText(text =>
      text.setValue(this.plugin.settings.folder).onChange(async value => {
        this.plugin.queueSettings({ folder: value });
      })
    );
    new Setting(this.containerEl)
      .addButton(button => button.setButtonText('Sync now').onClick(() => this.plugin.run(true)))
      .addButton(button => button.setButtonText('Review').onClick(() => this.plugin.review()));
  }
}
