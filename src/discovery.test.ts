import { expect, it, vi } from 'vitest';
import { discover, emptyDiscovery, inScope, listFolders, selectedFolders, validateEntry } from './discovery';
const note = (id: string, time = '2026-10-07T10:00:00.000Z') => ({ id, title: id, folder_id: null, updated_at: time, trashed_at: null, can_write: true });
it('persists a partial inventory and resumes without dropping prior membership', async () => {
  const state = emptyDiscovery('all'); state.entries.old = note('old');
  const request = vi.fn().mockResolvedValueOnce({ results: [note('new')], has_more: true, next_cursor: 'next' });
  const partial = await discover(state, request, 100, 1);
  expect(partial.entries).toEqual(state.entries); expect(partial.watermark).toBeUndefined(); expect(partial.queue).toEqual([]);
  const finish = vi.fn().mockResolvedValue({ results: [note('last')], has_more: false });
  const result = await discover(structuredClone(partial), finish, 200);
  expect(finish.mock.calls[0][0]).toContain('cursor=next');
  expect(result.queue).toEqual(['new', 'last', 'old']); expect(result.entries.old).toBeDefined(); expect(result.pass).toBeUndefined();
});
it('does not advance original checkpoint after failure mid-pagination', async () => {
  const state = emptyDiscovery('all');
  const request = vi.fn().mockResolvedValueOnce({results:[note('one')],has_more:true,next_cursor:'two'}).mockRejectedValueOnce(new Error('offline'));
  await expect(discover(state,request,100)).rejects.toThrow('offline');
  expect(state).toEqual(emptyDiscovery('all'));
});
it('reuses overlapping delta without repeatedly scheduling unchanged rows', async () => {
  const request = vi.fn().mockResolvedValue({ results: [note('one')], has_more: false });
  const initial = await discover(emptyDiscovery('all'), request, 100);
  initial.queue = [];
  const next = await discover(initial, request, 200);
  expect(request.mock.calls[1][0]).toContain('since=2026-10-07T09%3A59%3A00.000Z');
  expect(next.queue).toEqual([]);
});
it('reconciles periodically and checks missing IDs without forgetting baselines', async () => {
  const state = await discover(emptyDiscovery('all'), async () => ({results:[note('one')],has_more:false}), 100);
  state.queue=[];
  const req=vi.fn().mockResolvedValue({results:[],has_more:false});
  const result=await discover(state,req,1_000_000);
  expect(req.mock.calls[0][0]).not.toContain('since=');expect(result.queue).toEqual(['one']);expect(result.entries.one).toBeDefined();
});
it('deduplicates concurrent repeated rows and queues changed permissions or folder', async () => {
  const s=emptyDiscovery('all'); s.entries.one=note('one');
  const req=vi.fn().mockResolvedValueOnce({results:[note('one')],has_more:true,next_cursor:'next'})
    .mockResolvedValueOnce({results:[{...note('one'),can_write:false,folder_id:'folder'}],has_more:false});
  const result=await discover(s,req,100);expect(result.queue).toEqual(['one']);expect(result.entries.one.can_write).toBe(false);
});
it('handles more than 50 notes and limits page work per invocation',async()=>{
  const req=vi.fn().mockImplementation(async()=>({results:Array.from({length:100},(_,i)=>note(`n${req.mock.calls.length}_${i}`)),has_more:true,next_cursor:`p${req.mock.calls.length}`}));
  const partial=await discover(emptyDiscovery('all'),req,100);
  expect(req).toHaveBeenCalledTimes(5);expect(Object.keys(partial.pass!.rows)).toHaveLength(500);
});
it('rejects malformed responses and repeating cursors without losing original state',async()=>{
  const s=emptyDiscovery('all');
  await expect(discover(s,async()=>({results:[],has_more:true,next_cursor:'x'}),100)).rejects.toThrow('Invalid');
  await expect(discover(s,async()=>({results:[note('one')],has_more:true,next_cursor:'x'}),100)).rejects.toThrow('repeated');
  expect(()=>validateEntry({...note('one'),id:'__proto__'})).toThrow('Invalid');
});
it('selects exact multiple folders and optionally their descendants, never unfiled notes',()=>{
  const fs=[{id:'a',name:'A',parent_id:null},{id:'b',name:'B',parent_id:'a'},{id:'c',name:'C',parent_id:'b'},{id:'other',name:'Other',parent_id:null}];
  const selection={mode:'folders' as const,folderIds:['a'],descendants:true};
  const set=selectedFolders(selection,fs);expect([...set]).toEqual(['a','b','c']);
  expect(inScope({folder_id:null,trashed_at:null},selection,set)).toBe(false);
  expect(inScope({folder_id:'other',trashed_at:null},selection,set)).toBe(false);
  expect(inScope({folder_id:'c',trashed_at:null},selection,set)).toBe(true);
  expect([...selectedFolders({...selection,descendants:false,folderIds:['a','other']},fs)]).toEqual(['a','other']);
  expect(inScope({folder_id:null,trashed_at:null},{...selection,mode:'all'},set)).toBe(true);
  expect(inScope({folder_id:'a',trashed_at:'2026-10-07'},selection,set)).toBe(false);
});
it('paginates folder choices',async()=>{
  const req=vi.fn().mockResolvedValueOnce({results:[{id:'a',name:'A',parent_id:null}],has_more:true,next_cursor:'p2'})
    .mockResolvedValueOnce({results:[{id:'b',name:'B',parent_id:'a'}],has_more:false});
  expect((await listFolders(req)).map(f=>f.id)).toEqual(['a','b']);expect(req.mock.calls[1][0]).toContain('cursor=p2');
});
it('detects cursor cycles across resumed invocations', async()=>{
  const req=vi.fn().mockResolvedValueOnce({results:[note('one')],has_more:true,next_cursor:'a'})
    .mockResolvedValueOnce({results:[note('two')],has_more:true,next_cursor:'b'})
    .mockResolvedValueOnce({results:[note('three')],has_more:true,next_cursor:'a'});
  const first=await discover(emptyDiscovery('all'),req,100,1);
  const second=await discover(first,req,200,1);
  await expect(discover(second,req,300,1)).rejects.toThrow('repeated');
});
