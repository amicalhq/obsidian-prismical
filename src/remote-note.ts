import { GlobalSyncError, type RemoteNote } from './engine';

/** Validate remote identity before using it in vault paths or sync checkpoints. */
export function validateNote(value: unknown, requestedId: string): RemoteNote {
  const note = value as Partial<RemoteNote> | null;
  const timestamp = (x: unknown): x is string => typeof x === 'string' && Number.isFinite(Date.parse(x));
  if (
    !note ||
    typeof note !== 'object' ||
    !/^[\w-]{1,160}$/.test(requestedId) ||
    note.id !== requestedId ||
    typeof note.title !== 'string' ||
    (note.body !== null && typeof note.body !== 'string') ||
    typeof note.sync_revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(note.sync_revision) ||
    (note.sync_problem !== null && typeof note.sync_problem !== 'string') ||
    typeof note.can_write !== 'boolean' ||
    (note.trashed_at !== null && typeof note.trashed_at !== 'string') ||
    !timestamp(note.created_at) ||
    !timestamp(note.updated_at)
  ) {
    throw new GlobalSyncError('Invalid note sync response. Contact Prismical support.');
  }
  return { ...note, body: note.body ?? '' } as RemoteNote;
}
