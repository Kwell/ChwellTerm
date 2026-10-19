import { describe, it, expect, vi } from 'vitest';
import { TransferQueue, type NewTransfer } from './transferQueue';
import type { TransferProgress } from './types';

const job = (id: string, tabId = 'ssh-a'): NewTransfer => ({ id, tabId, sessionName: tabId, name: id + '.txt', direction: 'upload', localPath: 'C:/local/' + id, remotePath: '/captured', batch: false });
function harness() {
  const pending = new Map<string, { resolve: () => void; reject: (reason: string) => void; progress: (value: TransferProgress) => void }>();
  const starts: NewTransfer[] = [], cancelled: string[] = [];
  const queue = new TransferQueue((job, progress) => {
    starts.push({ ...job }); return new Promise<void>((resolve, reject) => { pending.set(job.id, { resolve, reject, progress }); });
  }, async id => { cancelled.push(id); }, () => {});
  return { queue, starts, pending, cancelled };
}
describe('runtime transfer queue', () => {
  it('pauses a running upload, preserves its checkpoint on retry failure and cleans it through IPC', async () => {
    const {queue,pending,cancelled,starts} = harness(); queue.enqueue([job('a'),job('b')]);
    await queue.pause('a'); expect(queue.jobs[0].phase).toBe('pausing'); expect(starts).toHaveLength(1);
    pending.get('a')!.reject('传输已暂停'); await vi.waitFor(() => expect(starts).toHaveLength(2));
    expect(queue.jobs[0]).toMatchObject({phase:'paused',checkpoint:true});
    queue.resume('a'); pending.get('b')!.resolve(); await vi.waitFor(() => expect(starts).toHaveLength(3));
    pending.get('a')!.reject('SFTP 未就绪'); await vi.waitFor(() => expect(queue.jobs[0].phase).toBe('interrupted'));
    await queue.cancel('a'); expect(cancelled).toEqual(['a']); expect(queue.jobs[0].phase).toBe('cancelled');
  });
  it('retains uploads across disconnect and requires manual resume in the original tab', async () => {
    const {queue,pending,starts,cancelled} = harness(); queue.enqueue([job('a')]); queue.stopTab('ssh-a',true);
    expect(cancelled).toEqual([]); pending.get('a')!.reject('可恢复：连接中断');
    await vi.waitFor(() => expect(queue.jobs[0].phase).toBe('interrupted'));
    queue.resume('a'); expect(starts).toHaveLength(1); queue.allowTab('ssh-a'); expect(starts).toHaveLength(1);
    queue.resume('a'); expect(starts).toHaveLength(2); pending.get('a')!.resolve();
  });
  it('keeps a paused upload and refuses tab disposal when remote cleanup fails', async () => {
    let reject!: (reason:string) => void; let fail = true;
    const queue = new TransferQueue(() => new Promise<void>((_,r) => {reject=r;}),async () => {if(fail) throw Error('未清理 /.twb-upload.part');},()=>{});
    queue.enqueue([job('a')]); await queue.pause('a'); reject('传输已暂停');
    await vi.waitFor(() => expect(queue.jobs[0].phase).toBe('paused'));
    expect(await queue.discardTab('ssh-a')).toBe(false); expect(queue.jobs[0]).toMatchObject({phase:'paused',checkpoint:true});
    expect(queue.jobs[0].error).toContain('/.twb-upload.part'); queue.clearFinished(); expect(queue.jobs).toHaveLength(1);
    fail=false; expect(await queue.discardTab('ssh-a')).toBe(true); expect(queue.jobs[0].phase).toBe('cancelled');
  });
  it('waits for an active upload cancellation to finish before allowing tab disposal', async () => {
    const {queue,pending} = harness(); queue.enqueue([job('a')]); let disposed=false;
    const result=queue.discardTab('ssh-a').then(ok => {disposed=ok;return ok;}); await Promise.resolve(); expect(disposed).toBe(false);
    pending.get('a')!.reject('传输已取消'); expect(await result).toBe(true);
  });
  it('pauses waiting uploads without IPC and resumes them when their session is available', async () => {
    const { queue, pending, starts, cancelled } = harness(); queue.enqueue([job('a'), job('b')]);
    await queue.pause('b'); expect(queue.jobs[1].phase).toBe('paused'); expect(cancelled).toHaveLength(0);
    pending.get('a')!.resolve(); await vi.waitFor(() => expect(queue.jobs[0].phase).toBe('done'));
    expect(starts).toHaveLength(1); queue.resume('b'); expect(starts.map(j => j.id)).toEqual(['a','b']); pending.get('b')!.resolve();
  });
  it('pausing download releases its slot only after checkpoint save and keeps it during clear', async () => {
    const pending = new Map<string, {resolve: () => void; reject: (text: string) => void; progress: (value: TransferProgress) => void}>();
    const starts: string[] = [], pauses: string[] = [];
    const queue = new TransferQueue((job, progress) => new Promise<void>((resolve,reject) => {starts.push(job.id); pending.set(job.id,{resolve,reject,progress});}), async () => {}, () => {}, () => {}, () => {}, async id => {pauses.push(id);});
    queue.enqueue([{...job('a'),direction:'download'},job('b')]); await queue.pause('a');
    expect(queue.jobs[0].phase).toBe('pausing'); expect(starts).toEqual(['a']);
    pending.get('a')!.progress({name:'a',total:100,transferred:30}); expect(pauses).toEqual(['a','a']);
    pending.get('a')!.reject('传输已暂停'); await vi.waitFor(() => expect(starts).toEqual(['a','b']));
    expect(queue.jobs[0].phase).toBe('paused'); queue.clearFinished(); expect(queue.jobs).toHaveLength(2);
    queue.resume('a'); pending.get('b')!.resolve(); await vi.waitFor(() => expect(starts).toEqual(['a','b','a']));
    expect(queue.jobs[0].initialBytes).toBe(30); pending.get('a')!.resolve();
  });
  it('retains interrupted downloads across disconnect, requires manual resume and cancels abandoned checkpoints', async () => {
    const {queue, pending, cancelled, starts} = harness(); queue.enqueue([{...job('a'),direction:'download'},job('b')]);
    queue.stopTab('ssh-a',true); expect(cancelled).toHaveLength(0); expect(queue.jobs[0].phase).toBe('pausing');
    pending.get('a')!.reject('可恢复：传输已取消'); await vi.waitFor(() => expect(queue.jobs[0].phase).toBe('interrupted'));
    queue.resume('a'); expect(starts).toHaveLength(1); queue.allowTab('ssh-a'); expect(starts).toHaveLength(1);
    queue.resume('a'); expect(starts).toHaveLength(2); pending.get('a')!.reject('可恢复：远端文件已改变');
    await vi.waitFor(() => expect(queue.jobs[0].phase).toBe('interrupted')); await queue.cancel('a');
    expect(cancelled).toEqual(['a']); expect(queue.jobs[0].phase).toBe('cancelled');
  });
  it('cancel wins over in-flight pause and deletes a checkpoint returned after cancellation', async () => {
    const {queue,pending,cancelled} = harness(); queue.enqueue([{...job('a'),direction:'download'}]); await queue.pause('a'); await queue.cancel('a');
    pending.get('a')!.reject('传输已暂停'); await vi.waitFor(() => expect(queue.jobs[0].phase).toBe('cancelled'));
    expect(cancelled).toEqual(['a','a']);
  });
  it('cancels a resumed checkpoint while it is waiting behind another transfer', async () => {
    const {queue,pending,cancelled,starts} = harness(); queue.enqueue([{...job('a'),direction:'download'},job('b')]);
    await queue.pause('a'); pending.get('a')!.reject('传输已暂停'); await vi.waitFor(() => expect(starts).toHaveLength(2));
    queue.resume('a'); expect(queue.jobs[0]).toMatchObject({phase:'queued',checkpoint:true}); await queue.cancel('a');
    expect(cancelled).toEqual(['a']); expect(queue.jobs[0].phase).toBe('cancelled'); pending.get('b')!.resolve();
    await vi.waitFor(() => expect(queue.jobs[1].phase).toBe('done')); expect(starts).toHaveLength(2);
  });
  it('keeps a saved checkpoint when reconnect succeeds without SFTP or the download directory disappears', async () => {
    const {queue,pending,cancelled} = harness(); queue.enqueue([{...job('a'),direction:'download'}]); await queue.pause('a');
    pending.get('a')!.reject('传输已暂停'); await vi.waitFor(() => expect(queue.jobs[0].phase).toBe('paused'));
    queue.resume('a'); pending.get('a')!.reject('SFTP 未就绪'); await vi.waitFor(() => expect(queue.jobs[0].phase).toBe('interrupted'));
    queue.clearFinished(); expect(queue.jobs[0].checkpoint).toBe(true); queue.resume('a'); pending.get('a')!.reject('无效下载目录');
    await vi.waitFor(() => expect(queue.jobs[0].phase).toBe('interrupted')); await queue.cancel('a'); expect(cancelled).toEqual(['a']);
  });
  it('runs serially, accepts additions, preserves captured targets and continues after failure', async () => {
    const { queue, starts, pending } = harness(); queue.enqueue([job('a'), job('b')]); queue.enqueue([job('c', 'ssh-b')]);
    expect(starts.map(j => j.id)).toEqual(['a']); pending.get('a')!.reject('missing file');
    await vi.waitFor(() => expect(starts.map(j => j.id)).toEqual(['a', 'b']));
    expect(queue.jobs[0].phase).toBe('error'); pending.get('b')!.resolve();
    await vi.waitFor(() => expect(starts.map(j => j.id)).toEqual(['a', 'b', 'c']));
    expect(starts[2]).toMatchObject({ tabId: 'ssh-b', remotePath: '/captured' }); pending.get('c')!.resolve();
    await vi.waitFor(() => expect(queue.jobs[2].phase).toBe('done'));
  });
  it('cancels waiting tasks locally and waits for running cleanup before the next start', async () => {
    const { queue, starts, pending, cancelled } = harness(); queue.enqueue([job('a'), job('b'), job('c')]);
    await queue.cancel('b'); await queue.cancel('a'); expect(cancelled).toEqual(['a']);
    expect(queue.jobs.map(j => j.phase)).toEqual(['cancelling', 'cancelled', 'queued']);
    expect(starts).toHaveLength(1); pending.get('a')!.reject('传输已取消');
    await vi.waitFor(() => expect(starts.map(j => j.id)).toEqual(['a', 'c']));
    expect(queue.jobs[0].phase).toBe('cancelled'); pending.get('c')!.resolve();
  });
  it('disconnect cancels its tasks and invalidates a pending picker even after reconnect', async () => {
    const { queue, starts, pending } = harness(); const epoch = queue.epoch('ssh-a');
    queue.enqueue([job('a'), job('b'), job('c', 'ssh-b')]); queue.stopTab('ssh-a');
    expect(queue.available('ssh-a', epoch)).toBe(false); expect(queue.jobs[1].phase).toBe('cancelled');
    queue.allowTab('ssh-a'); expect(queue.available('ssh-a')).toBe(true); expect(queue.available('ssh-a', epoch)).toBe(false);
    pending.get('a')!.reject('传输已取消'); await vi.waitFor(() => expect(starts.map(j => j.id)).toEqual(['a', 'c'])); pending.get('c')!.resolve();
  });
  it('retries cancellation after first progress, ignores late progress and records a late success accurately', async () => {
    const { queue, pending, cancelled } = harness(); queue.enqueue([job('a')]); await queue.cancel('a');
    const progress = { name: 'a', total: 10, transferred: 1 }; pending.get('a')!.progress(progress);
    expect(cancelled).toEqual(['a', 'a']); expect(queue.jobs[0].phase).toBe('cancelling'); pending.get('a')!.resolve();
    await vi.waitFor(() => expect(queue.jobs[0].phase).toBe('done')); pending.get('a')!.progress({ ...progress, transferred: 9 });
    expect(queue.jobs[0].progress?.transferred).toBe(1);
  });
  it('cancel all prevents any waiting task starting; clear removes only ended tasks', async () => {
    const { queue, starts, pending } = harness(); queue.enqueue([job('a'), job('b'), job('c')]); queue.cancelAll(); queue.clearFinished();
    expect(queue.jobs.map(j => j.id)).toEqual(['a']); pending.get('a')!.reject('传输已取消');
    await vi.waitFor(() => expect(queue.jobs[0].phase).toBe('cancelled')); expect(starts).toHaveLength(1);
    queue.clearFinished(); expect(queue.jobs).toHaveLength(0); queue.enqueue([job('d')]); expect(starts).toHaveLength(2); pending.get('d')!.resolve();
  });
  it('rejects oversized batches atomically and duplicate IDs', () => {
    const { queue } = harness(); expect(() => queue.enqueue(Array.from({ length: 201 }, (_, i) => job(String(i))))).toThrow('200');
    expect(queue.jobs).toHaveLength(0); expect(() => queue.enqueue([job('a'), job('a')])).toThrow('重复');
    expect(queue.jobs).toHaveLength(0); queue.stopTab('ssh-a'); expect(() => queue.enqueue([job('b')])).toThrow('断开');
  });
});
