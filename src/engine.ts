import { diff3Merge } from 'node-diff3';

export interface RemoteNote {
  id: string;
  title: string;
  body: string;
  sync_revision: string;
  sync_problem: string | null;
  can_write: boolean;
  trashed_at: string | null;
}
export interface LocalNote {
  path: string;
  body: string;
}
export interface Conflict {
  local: string;
  remote: string;
  revision: string;
  reason: string;
}
export interface SyncState {
  base?: string;
  path?: string;
  pending?: { local: string; target: string; acknowledged?: string };
  conflict?: Conflict;
  blockedPush?: { local: string; revision: string; reason: string };
  excluded?: boolean;
}
export interface SyncPorts {
  getRemote(id: string): Promise<RemoteNote>;
  putRemote(id: string, body: string, revision: string): Promise<RemoteNote>;
  getLocal(id: string): Promise<LocalNote | null>;
  createLocal(note: RemoteNote): Promise<LocalNote>;
  replaceLocal(id: string, expected: string, body: string): Promise<boolean>;
  load(id: string): Promise<SyncState>;
  save(id: string, state: SyncState): Promise<void>;
  active(): boolean;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfterMs = 0
  ) {
    super(message);
  }
}

export class GlobalSyncError extends Error {}
export class StaleConflictError extends Error {
  constructor() {
    super('The note changed during review. Review the new versions.');
  }
}

/** Only connection/account failures stop the batch; a damaged file must not starve other notes. */
export async function syncNotes(
  ids: string[],
  ports: SyncPorts,
  report: (id: string, outcome: string) => void
) {
  for (const id of ids) {
    if (!ports.active()) break;
    try {
      report(id, await syncNote(id, ports));
    } catch (error) {
      report(id, error instanceof Error ? error.message : 'Sync failed');
      if (
        error instanceof GlobalSyncError ||
        (error instanceof ApiError &&
          (error.status === 401 || error.status === 429 || error.status >= 500))
      )
        throw error;
    }
  }
}

export function reconcile(base: string | undefined, local: string, remote: string): string | null {
  if (local === remote) return local;
  if (base === undefined) return null;
  if (local === base) return remote;
  if (remote === base) return local;
  const parts = diff3Merge(local.split('\n'), base.split('\n'), remote.split('\n'));
  if (parts.some(part => 'conflict' in part)) return null;
  return parts.flatMap(part => ('ok' in part ? part.ok : [])).join('\n');
}

/** One caller serializes work. File contents remain the durable source of unsent user edits. */
export async function syncNote(id: string, ports: SyncPorts): Promise<string> {
  const state = await ports.load(id);
  if (state.excluded) return 'Disconnected';
  const remote = await ports.getRemote(id);
  if (!ports.active()) return 'Paused';
  if (remote.trashed_at) return 'Unavailable in Prismical';
  if (!remote.sync_revision) throw new Error('The Prismical server needs the sync API update');
  let local = await ports.getLocal(id);
  if (!local) {
    if (state.path) {
      await ports.save(id, { ...state, excluded: true });
      return 'Disconnected after local removal';
    }
    local = await ports.createLocal(remote);
    await ports.save(id, { base: remote.body, path: local.path });
    return remote.sync_problem ?? 'Up to date';
  }
  // Rebase typing that happened during an acknowledged request before advancing the baseline.
  if (
    state.pending &&
    (state.pending.acknowledged !== undefined || remote.body === state.pending.target)
  ) {
    const acknowledged = state.pending.acknowledged ?? remote.body;
    const rebased = reconcile(state.pending.local, local.body, acknowledged);
    if (rebased === null) {
      await ports.save(id, {
        ...state,
        conflict: {
          local: local.body,
          remote: remote.body,
          revision: remote.sync_revision,
          reason: 'Edited while a sync write was in flight',
        },
      });
      return 'Conflict needs review';
    }
    if (!(await ports.replaceLocal(id, local.body, rebased))) return 'Local edit pending';
    local = { ...local, body: rebased };
    state.base = acknowledged;
    state.pending = undefined;
    state.conflict = undefined;
    await ports.save(id, { ...state, path: local.path });
  }
  if (state.conflict) return 'Conflict needs review';
  if (state.blockedPush?.local === local.body && state.blockedPush.revision === remote.sync_revision)
    return state.blockedPush.reason;
  const target = reconcile(state.base, local.body, remote.body);
  if (target === null) {
    await ports.save(id, {
      ...state,
      path: local.path,
      conflict: {
        local: local.body,
        remote: remote.body,
        revision: remote.sync_revision,
        reason: state.pending
          ? 'A previous write could not be confirmed. Review both versions; server formatting may differ.'
          : state.base === undefined ? 'No shared baseline' : 'Both sides changed',
      },
    });
    return 'Conflict needs review';
  }
  if (target === local.body && target === remote.body) {
    await ports.save(id, { base: remote.body, path: local.path });
    return remote.sync_problem ?? 'Up to date';
  }
  if (target !== remote.body && (remote.sync_problem || !remote.can_write)) {
    if (!ports.active()) return 'Paused';
    if (!(await ports.replaceLocal(id, local.body, target))) return 'Local edit pending';
    // Remote becomes the comparison baseline; local-only edits remain an unsent delta.
    await ports.save(id, { base: remote.body, path: local.path });
    return remote.sync_problem ?? 'Read-only in Prismical; local edits retained';
  }
  if (!ports.active()) return 'Paused';
  await ports.save(id, { ...state, path: local.path, pending: { local: local.body, target } });
  let result: RemoteNote;
  try {
    result = target === remote.body ? remote : await ports.putRemote(id, target, remote.sync_revision);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 422) throw error;
    const reason = `Upload blocked: ${error.message}. Edit the note before retrying.`;
    await ports.save(id, {
      ...state, path: local.path, pending: undefined,
      blockedPush: { local: local.body, revision: remote.sync_revision, reason },
    });
    return reason;
  }
  await ports.save(id, {
    ...state,
    path: local.path,
    pending: { local: local.body, target, acknowledged: result.body },
  });
  if (!ports.active()) return 'Paused';
  if (!(await ports.replaceLocal(id, local.body, result.body))) {
    return 'Local edit pending';
  }
  await ports.save(id, { base: result.body, path: local.path });
  return result.sync_problem ?? 'Up to date';
}

export async function resolveConflict(
  id: string,
  choice: 'local' | 'remote',
  ports: SyncPorts,
  displayed: Conflict,
  backup: (conflict: Conflict) => Promise<void>
): Promise<void> {
  const state = await ports.load(id);
  const conflict = state.conflict;
  if (
    !conflict ||
    conflict.local !== displayed.local ||
    conflict.remote !== displayed.remote ||
    conflict.revision !== displayed.revision
  )
    throw new StaleConflictError();
  const [local, remote] = await Promise.all([ports.getLocal(id), ports.getRemote(id)]);
  if (!local || local.body !== conflict.local || remote.sync_revision !== conflict.revision) {
    if (local)
      await ports.save(id, {
        ...state,
        conflict: {
          local: local.body,
          remote: remote.body,
          revision: remote.sync_revision,
          reason: 'Changed during review; review the new versions',
        },
      });
    throw new StaleConflictError();
  }
  if (!ports.active()) throw new Error('Sync is paused');
  if (remote.trashed_at) throw new Error('Unavailable in Prismical');
  const target = choice === 'local' ? local.body : remote.body;
  if (choice === 'local' && (remote.sync_problem || !remote.can_write))
    throw new Error(remote.sync_problem ?? 'Read-only note');
  await backup({ ...conflict });
  if (!ports.active()) throw new Error('Sync is paused');
  // Both versions stay in conflict state until the selected result is durable.
  await ports.save(id, { ...state, pending: { local: local.body, target } });
  const result =
    choice === 'local' ? await ports.putRemote(id, target, remote.sync_revision) : remote;
  await ports.save(id, {
    ...state,
    pending: { local: local.body, target, acknowledged: result.body },
  });
  if (!ports.active()) throw new Error('Sync is paused');
  const applied = await ports.replaceLocal(id, local.body, result.body);
  if (applied) await ports.save(id, { base: result.body, path: local.path });
  if (!applied) throw new Error('Saved the resolution; a newer local edit is still pending.');
}
