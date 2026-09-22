import { expect, it } from 'vitest';
import { validateNote } from './remote-note';

const note = {
  id: 'note-1', title: 'Note', body: 'Content', sync_revision: 'a'.repeat(64),
  sync_problem: null, can_write: true, trashed_at: null,
};

it('accepts the requested note and normalizes an empty body', () => {
  expect(validateNote(note, note.id)).toEqual(note);
  expect(validateNote({ ...note, body: null }, note.id).body).toBe('');
});

it.each([
  { id: '../../outside' },
  { id: 'different-note' },
  { title: null },
  { body: {} },
  { sync_revision: 'invalid' },
  { sync_problem: undefined },
  { can_write: 'false' },
  { trashed_at: undefined },
])('rejects unsafe or malformed server fields: %j', patch => {
  expect(() => validateNote({ ...note, ...patch }, note.id)).toThrow('Invalid note');
});

it('rejects an unsafe ID even if the response repeats it', () => {
  expect(() => validateNote({ ...note, id: '../outside' }, '../outside')).toThrow();
});
