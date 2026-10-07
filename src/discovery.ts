import { GlobalSyncError } from './engine';
export type Selection = { mode: 'manual' | 'all' | 'folders'; folderIds: string[]; descendants: boolean };
export type Folder = { id: string; name: string; parent_id: string | null };
export type Entry = { id: string; title: string; folder_id: string | null; updated_at: string; trashed_at: string | null; can_write: boolean };
export interface DiscoveryState {
  scope: string;
  entries: Record<string, Entry>;
  queue: string[];
  watermark?: string;
  reconciledAt: number;
  folderScope?: string[];
  pass?: { full: boolean; since?: string; cursor?: string; rows: Record<string, Entry>; max?: string; startedAt: number; cursors?: string[] };
}
export const emptyDiscovery = (scope: string): DiscoveryState => ({ scope, entries: {}, queue: [], reconciledAt: 0 });
const safeId = (x: unknown): x is string => typeof x === 'string' && /^[\w-]{1,160}$/.test(x) && !['__proto__', 'constructor', 'prototype'].includes(x);
const timestamp = (x: unknown): x is string => typeof x === 'string' && Number.isFinite(Date.parse(x));
export function pageRows(value: unknown): { results: unknown[]; has_more: boolean; next_cursor?: string } {
  const p = value as any;
  if (!p || !Array.isArray(p.results) || typeof p.has_more !== 'boolean' ||
    (p.has_more && (typeof p.next_cursor !== 'string' || !p.next_cursor || p.results.length === 0)))
    throw new GlobalSyncError('Invalid discovery page; existing notes retained');
  return p;
}
export function validateEntry(value: unknown): Entry {
  const n = value as Entry;
  if (!n || !safeId(n.id) || typeof n.title !== 'string' || !(n.folder_id === null || safeId(n.folder_id)) ||
    !timestamp(n.updated_at) || !(n.trashed_at === null || timestamp(n.trashed_at)) || typeof n.can_write !== 'boolean')
    throw new GlobalSyncError('Invalid note listing; existing notes retained');
  return { id: n.id, title: n.title, folder_id: n.folder_id, updated_at: n.updated_at, trashed_at: n.trashed_at, can_write: n.can_write };
}
export async function listFolders(request: (path: string) => Promise<unknown>): Promise<Folder[]> {
  const folders = new Map<string, Folder>(); const cursors = new Set<string>(); let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const q = new URLSearchParams({ limit: '100', sort: 'created_at', order: 'asc' });
    if (cursor) q.set('cursor', cursor);
    const p = pageRows(await request('/folders?' + q));
    for (const row of p.results) {
      const f = row as Folder;
      if (!f || !safeId(f.id) || typeof f.name !== 'string' || !(f.parent_id === null || safeId(f.parent_id)))
        throw new GlobalSyncError('Invalid folder listing');
      folders.set(f.id, { id: f.id, name: f.name, parent_id: f.parent_id });
    }
    if (!p.has_more) return [...folders.values()];
    cursor = p.next_cursor!;
    if (cursors.has(cursor)) throw new GlobalSyncError('Folder cursor repeated');
    cursors.add(cursor);
  }
  throw new GlobalSyncError('Too many folder pages; narrow the workspace before syncing');
}
export function selectedFolders(selection: Selection, folders: Folder[]): Set<string> {
  const available = new Set(folders.map(f => f.id));
  const result = new Set(selection.folderIds.filter(id => available.has(id)));
  if (selection.descendants) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const f of folders) if (f.parent_id && result.has(f.parent_id) && !result.has(f.id)) { result.add(f.id); changed = true; }
    }
  }
  return result;
}
export function inScope(note: Pick<Entry, 'folder_id' | 'trashed_at'>, selection: Selection, folders: Set<string>) {
  return !note.trashed_at && (selection.mode === 'all' || (note.folder_id !== null && folders.has(note.folder_id)));
}
/** Persist each returned state before processing its queue. A partial inventory never removes membership. */
export async function discover(state: DiscoveryState, request: (path: string) => Promise<unknown>, now: number, pages = 5): Promise<DiscoveryState> {
  const next = structuredClone(state);
  if (!next.pass) {
    const full = !next.watermark || now - next.reconciledAt >= 15 * 60_000;
    next.pass = { full, rows: {}, startedAt: now,
      since: !full && next.watermark ? new Date(Date.parse(next.watermark) - 60_000).toISOString() : undefined };
  }
  const pass = next.pass;
  for (let i = 0; i < pages; i++) {
    const q = new URLSearchParams({ limit: '100', sort: pass.full ? 'created_at' : 'updated_at', order: 'asc' });
    if (pass.since) q.set('since', pass.since);
    if (pass.cursor) q.set('cursor', pass.cursor);
    const p = pageRows(await request('/notes?' + q));
    for (const raw of p.results) {
      const n = validateEntry(raw); pass.rows[n.id] = n;
      if (!pass.max || Date.parse(n.updated_at) > Date.parse(pass.max)) pass.max = n.updated_at;
    }
    if (p.has_more) {
      if (p.next_cursor === pass.cursor || pass.cursors?.includes(p.next_cursor!)) throw new GlobalSyncError('Note cursor repeated');
      pass.cursors = [...(pass.cursors ?? []), p.next_cursor!];
      pass.cursor = p.next_cursor; continue;
    }
    const pending = new Set(next.queue);
    for (const n of Object.values(pass.rows)) {
      const old = next.entries[n.id];
      if (!old || old.updated_at !== n.updated_at || old.folder_id !== n.folder_id || old.can_write !== n.can_write || old.trashed_at !== n.trashed_at) pending.add(n.id);
    }
    // Keep missing IDs for explicit detail checks; never interpret absence as deletion.
    if (pass.full) for (const id of Object.keys(next.entries)) if (!pass.rows[id]) pending.add(id);
    next.entries = { ...next.entries, ...pass.rows };
    next.queue = [...pending];
    if (pass.max && (!next.watermark || Date.parse(pass.max) > Date.parse(next.watermark))) next.watermark = pass.max;
    if (pass.full) next.reconciledAt = pass.startedAt;
    next.pass = undefined;
    break;
  }
  return next;
}
