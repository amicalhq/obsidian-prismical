import { describe, expect, it, vi } from 'vitest';
import {
  reconcile,
  syncNotes,
  GlobalSyncError,
  ApiError,
  syncNote,
  resolveConflict,
  type SyncPorts,
  type SyncState,
  type RemoteNote,
} from './engine';
function setup(
  localBody = 'base',
  remoteBody = 'base',
  state: SyncState = { base: 'base', path: 'note.md' }
) {
  let local = { path: 'note.md', body: localBody };
  let remote: RemoteNote = {
    id: 'n',
    title: 'Note',
    body: remoteBody,
    sync_revision: '1',
    sync_problem: null,
    can_write: true,
    trashed_at: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
  };
  const ports: SyncPorts = {
    active: () => true,
    load: async () => structuredClone(state),
    save: async (_, next) => {
      state = structuredClone(next);
    },
    getLocal: async () => ({ ...local }),
    createLocal: async note => (local = { path: 'note.md', body: note.body }),
    replaceLocal: async (_, expected, body) => {
      if (local.body !== expected) return false;
      local.body = body;
      return true;
    },
    getRemote: async () => ({ ...remote }),
    putRemote: vi.fn(async (_, body, revision) => {
      expect(revision).toBe(remote.sync_revision);
      remote = { ...remote, body, sync_revision: '2' };
      return { ...remote };
    }),
  };
  return {
    ports,
    state: () => state,
    local: () => local,
    remote: () => remote,
    edit: (body: string) => {
      local.body = body;
    },
  };
}
describe('two-way synchronization', () => {
  it('merges non-overlapping changes and stops overlapping edits', () => {
    expect(reconcile('a\nb\nc', 'A\nb\nc', 'a\nb\nC')).toBe('A\nb\nC');
    expect(reconcile('a', 'b', 'c')).toBeNull();
    expect(reconcile(undefined, 'b', 'c')).toBeNull();
    expect(reconcile('a\nb', 'a', 'a\nB')).toBeNull();
  });
  it('pulls a body-only update without relying on note metadata timestamps', async () => {
    const s = setup('base', 'remote');
    await syncNote('n', s.ports);
    expect(s.local().body).toBe('remote');
    expect(s.ports.putRemote).not.toHaveBeenCalled();
  });
  it('pushes only with the observed revision', async () => {
    const s = setup('local');
    await syncNote('n', s.ports);
    expect(s.remote().body).toBe('local');
    expect(s.state().base).toBe('local');
    await syncNote('n', s.ports);
    expect(s.ports.putRemote).toHaveBeenCalledTimes(1);
  });
  it('preserves typing during a network write and rebases it on acknowledgement', async () => {
    const s = setup('A\nb\nmiddle\nc', 'a\nb\nmiddle\nC', {
      base: 'a\nb\nmiddle\nc',
      path: 'note.md',
    });
    const write = s.ports.putRemote;
    s.ports.putRemote = async (...args) => {
      const result = await write(...args);
      s.edit('A\nB\nmiddle\nc');
      return result;
    };
    await syncNote('n', s.ports);
    expect(s.local().body).toBe('A\nB\nmiddle\nc');
    expect(s.state().pending?.acknowledged).toBe('A\nb\nmiddle\nC');
    s.ports.putRemote = write;
    await syncNote('n', s.ports);
    expect(s.local().body).toBe('A\nB\nmiddle\nC');
    expect(s.remote().body).toBe('A\nB\nmiddle\nC');
  });
  it('recovers a lost response without a duplicate write', async () => {
    const s = setup('local');
    const write = s.ports.putRemote;
    s.ports.putRemote = async (...args) => {
      await write(...args);
      throw new Error('timeout');
    };
    await expect(syncNote('n', s.ports)).rejects.toThrow('timeout');
    s.ports.putRemote = write;
    await syncNote('n', s.ports);
    expect(write).toHaveBeenCalledTimes(1);
    expect(s.state().pending).toBeUndefined();
  });
  it('retains both conflict versions and refuses a stale resolution', async () => {
    const s = setup('local', 'remote');
    await syncNote('n', s.ports);
    expect(s.state().conflict).toMatchObject({ local: 'local', remote: 'remote' });
    const displayed = structuredClone(s.state().conflict!);
    const backup = vi.fn(async () => {});
    s.edit('new edit');
    await expect(resolveConflict('n', 'remote', s.ports, displayed, backup)).rejects.toThrow(
      'changed'
    );
    // Clicking the same stale dialog a second time must still fail.
    await expect(resolveConflict('n', 'remote', s.ports, displayed, backup)).rejects.toThrow(
      'changed'
    );
    expect(backup).not.toHaveBeenCalled();
    expect(s.local().body).toBe('new edit');
    expect(s.ports.putRemote).not.toHaveBeenCalled();
    const refreshed = structuredClone(s.state().conflict!);
    await resolveConflict('n', 'remote', s.ports, refreshed, backup);
    expect(backup).toHaveBeenCalledWith(
      expect.objectContaining({ local: 'new edit', remote: 'remote' })
    );
    expect(s.local().body).toBe('remote');
  });
  it.each(['Duplicate linked files', 'Malformed YAML'])(
    'continues past note-specific failure: %s',
    async message => {
      const s = setup('local');
      const getLocal = s.ports.getLocal;
      s.ports.getLocal = async id => {
        if (id === 'broken') throw new Error(message);
        return getLocal(id);
      };
      const report = vi.fn();
      await syncNotes(['broken', 'n'], s.ports, report);
      expect(report.mock.calls).toEqual([
        ['broken', message],
        ['n', 'Up to date'],
      ]);
      expect(s.remote().body).toBe('local');
    }
  );
  it.each([
    new GlobalSyncError('offline'),
    new ApiError(401, 'unauthorized'),
    new ApiError(429, 'rate limited'),
    new ApiError(503, 'unavailable'),
  ])('stops the batch on a global failure: %s', async error => {
    const s = setup();
    s.ports.getRemote = vi.fn(async () => {
      throw error;
    });
    await expect(syncNotes(['first', 'second'], s.ports, vi.fn())).rejects.toBe(error);
    expect(s.ports.getRemote).toHaveBeenCalledTimes(1);
  });
  it('does not recreate a deleted linked file', async () => {
    const s = setup();
    s.ports.getLocal = async () => null;
    await syncNote('n', s.ports);
    expect(s.state().excluded).toBe(true);
  });
  it('preserves local edits when a note is unsupported', async () => {
    const s = setup('local');
    s.ports.getRemote = async () => ({ ...s.remote(), sync_problem: 'image' });
    expect(await syncNote('n', s.ports)).toBe('image');
    expect(s.ports.putRemote).not.toHaveBeenCalled();
  });
});

it.each([false, true])('pulls remote changes while retaining blocked local edits (unsupported=%s)', async unsupported => {
  const s = setup('A\nb\nc', 'a\nb\nC', { base: 'a\nb\nc', path: 'note.md' });
  s.ports.getRemote = async () => ({ ...s.remote(), can_write: false, sync_problem: unsupported ? 'Unsupported block' : null });
  await syncNote('n', s.ports);
  expect(s.local().body).toBe('A\nb\nC');
  expect(s.state().base).toBe('a\nb\nC');
  await syncNote('n', s.ports);
  expect(s.local().body).toBe('A\nb\nC');
  expect(s.state().conflict).toBeUndefined();
  expect(s.ports.putRemote).not.toHaveBeenCalled();
  s.remote().body = 'a\nb\nD';
  await syncNote('n', s.ports);
  expect(s.local().body).toBe('A\nb\nD');
});

it('retains the warning after a pull-only update of unsupported content', async () => {
  const s = setup('base', 'remote');
  s.ports.getRemote = async () => ({ ...s.remote(), sync_problem: 'Unsupported block' });
  expect(await syncNote('n', s.ports)).toBe('Unsupported block');
  expect(s.local().body).toBe('remote');
});

it('keeps an ambiguous normalized write for review instead of guessing acknowledgement', async () => {
  const s = setup('**local**');
  s.ports.putRemote = vi.fn(async () => {
    s.remote().body = '__local__';
    s.remote().sync_revision = '2';
    throw new GlobalSyncError('timeout');
  });
  await expect(syncNote('n', s.ports)).rejects.toThrow('timeout');
  expect(await syncNote('n', s.ports)).toBe('Conflict needs review');
  expect(s.state().conflict).toMatchObject({ local: '**local**', remote: '__local__' });
  expect(s.state().conflict?.reason).toContain('could not be confirmed');
  expect(s.ports.putRemote).toHaveBeenCalledTimes(1);
  expect(s.local().body).toBe('**local**');
});

it('backs up and conditionally writes the selected local conflict version', async () => {
  const s = setup('local', 'remote');
  await syncNote('n', s.ports);
  const backup = vi.fn(async () => {});
  await resolveConflict('n', 'local', s.ports, s.state().conflict!, backup);
  expect(backup).toHaveBeenCalledWith(expect.objectContaining({ local: 'local', remote: 'remote' }));
  expect(s.ports.putRemote).toHaveBeenCalledWith('n', 'local', '1');
  expect(s.state()).toEqual({ base: 'local', path: 'note.md' });
});

it('refuses a conflict write after the remote note is trashed', async () => {
  const s = setup('local', 'remote');
  await syncNote('n', s.ports);
  s.remote().trashed_at = '2026-01-01';
  const backup = vi.fn(async () => {});
  await expect(resolveConflict('n', 'local', s.ports, s.state().conflict!, backup)).rejects.toThrow('Unavailable');
  expect(s.ports.putRemote).not.toHaveBeenCalled();
  expect(backup).not.toHaveBeenCalled();
});

it('preserves overlapping typing during an acknowledged merged write as a conflict', async () => {
  const s = setup('A\nb\nc', 'a\nb\nC', { base: 'a\nb\nc', path: 'note.md' });
  const write = s.ports.putRemote;
  s.ports.putRemote = async (...args) => {
    const result = await write(...args);
    s.edit('A\nb\nTyping');
    return result;
  };
  await syncNote('n', s.ports);
  expect(await syncNote('n', s.ports)).toBe('Conflict needs review');
  expect(s.local().body).toBe('A\nb\nTyping');
  expect(s.state().conflict?.reason).toContain('in flight');
});

it('does not retry a rejected upload until local content or remote revision changes', async () => {
  const s = setup('unsupported');
  s.ports.putRemote = vi.fn(async () => { throw new ApiError(422, 'Unsupported content'); });
  expect(await syncNote('n', s.ports)).toContain('Upload blocked');
  expect(await syncNote('n', s.ports)).toContain('Upload blocked');
  expect(s.ports.putRemote).toHaveBeenCalledTimes(1);
  expect(s.state().pending).toBeUndefined();
  s.edit('changed unsupported');
  await syncNote('n', s.ports);
  expect(s.ports.putRemote).toHaveBeenCalledTimes(2);
  s.remote().sync_revision = '3';
  await syncNote('n', s.ports);
  expect(s.ports.putRemote).toHaveBeenCalledTimes(3);
});


it('pulls successive remote edits despite a rejected local upload', async () => {
  const s = setup('LOCAL\nb\nc', 'a\nb\nREMOTE', { base: 'a\nb\nc', path: 'note.md' });
  s.ports.putRemote = vi.fn(async () => { throw new ApiError(422, 'Unsupported content'); });
  await syncNote('n', s.ports);
  expect(s.local().body).toBe('LOCAL\nb\nREMOTE');
  expect(s.state().base).toBe('a\nb\nREMOTE');
  expect(s.state().blockedPush?.local).toBe(s.local().body);
  await syncNote('n', s.ports);
  expect(s.ports.putRemote).toHaveBeenCalledTimes(1);
  s.remote().body = 'a\nb\nREMOTE AGAIN'; s.remote().sync_revision = '2';
  await syncNote('n', s.ports);
  expect(s.local().body).toBe('LOCAL\nb\nREMOTE AGAIN');
  expect(s.state().base).toBe(s.remote().body);
  await syncNote('n', s.ports);
  expect(s.ports.putRemote).toHaveBeenCalledTimes(2);
});

it('does not overwrite typing during a rejected upload or advance its baseline', async () => {
  const s = setup('LOCAL\nb\nc', 'a\nb\nREMOTE', { base: 'a\nb\nc', path: 'note.md' });
  s.ports.putRemote = vi.fn(async () => {
    s.edit('NEW TYPING\nb\nc');
    throw new ApiError(422, 'Unsupported content');
  });
  expect(await syncNote('n', s.ports)).toBe('Local edit pending');
  expect(s.local().body).toBe('NEW TYPING\nb\nc');
  expect(s.state().base).toBe('a\nb\nc');
  expect(s.state().pending).toBeUndefined();
  expect(s.state().blockedPush).toBeUndefined();
});
