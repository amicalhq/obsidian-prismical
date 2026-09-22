import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { StateStore } from './store';

it('persists an in-flight checkpoint across restart and isolates accounts', async () => {
  const namespace = crypto.randomUUID();
  const first = new StateStore(namespace);
  const checkpoint = { base: 'before', path: 'note.md', pending: { local: 'edit', target: 'merged', acknowledged: 'canonical' } };
  await first.save('note', checkpoint);
  await first.close();
  const reopened = new StateStore(namespace);
  const other = new StateStore(namespace + ':other-account');
  expect(await reopened.load('note')).toEqual(checkpoint);
  expect(await other.load('note')).toEqual({});
  await reopened.close();
  await other.close();
});
