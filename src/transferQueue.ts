import type { TransferProgress } from './types';

export interface TransferJob {
  id: string; tabId: string; sessionName: string; direction: 'upload' | 'download';
  name: string; localPath: string; remotePath: string; batch: boolean;
  started: number; phase: 'queued' | 'running' | 'pausing' | 'paused' | 'interrupted' | 'cancelling' | 'done' | 'cancelled' | 'error';
  initialBytes?: number;
  checkpoint?: boolean;
  progress?: TransferProgress; error?: string;
}
export type NewTransfer = Omit<TransferJob, 'started' | 'phase' | 'progress' | 'error' | 'initialBytes' | 'checkpoint'>;
const finished = (job: TransferJob) => ['done', 'cancelled', 'error'].includes(job.phase);

// Runtime-only queue. Release a slot after backend completion, including cleanup.
export class TransferQueue {
  jobs: TransferJob[] = [];
  private active = false;
  private blocked = new Set<string>();
  private epochs = new Map<string, number>();
  private settled = new Set<() => void>();
  constructor(private execute: (job: TransferJob, progress: (value: TransferProgress) => void) => Promise<unknown>,
    private cancelRemote: (id: string) => Promise<unknown>, private changed: (jobs: TransferJob[]) => void,
    private completed: (job: TransferJob) => void = () => {}, private reportError: (text: string) => void = () => {},
    private pauseRemote: (id: string) => Promise<unknown> = async () => {}) {}
  epoch(tabId: string) { return this.epochs.get(tabId) || 0; }
  available(tabId: string, epoch = this.epoch(tabId)) { return !this.blocked.has(tabId) && this.epoch(tabId) === epoch; }
  allowTab(tabId: string) { this.blocked.delete(tabId); this.emit(); }
  private emit() { this.changed([...this.jobs]); for (const check of this.settled) check(); }
  private update(id: string, change: Partial<TransferJob>) {
    this.jobs = this.jobs.map(job => job.id === id ? { ...job, ...change } : job); this.emit();
  }
  enqueue(jobs: NewTransfer[]) {
    if (this.jobs.length + jobs.length > 200) throw Error('队列最多保留 200 项，请先清除已结束任务');
    if (new Set([...this.jobs, ...jobs].map(job => job.id)).size !== this.jobs.length + jobs.length) throw Error('重复传输 ID');
    if (jobs.some(job => !this.available(job.tabId))) throw Error('源会话已断开，请重新连接后选择文件');
    this.jobs = [...this.jobs, ...jobs.map(job => ({ ...job, phase: 'queued' as const, started: 0 }))];
    this.emit(); void this.pump();
  }
  clearFinished() { this.jobs = this.jobs.filter(job => !finished(job)); this.emit(); }
  async cancel(id: string) {
    const job = this.jobs.find(job => job.id === id);
    if (!job || finished(job) || job.phase === 'cancelling') return;
    if (['queued', 'paused'].includes(job.phase) && !job.checkpoint) { this.update(id, { phase: 'cancelled' }); return; }
    const inactive = job.phase === 'paused' || job.phase === 'interrupted' || (job.phase === 'queued' && !!job.checkpoint);
    this.update(id, { phase: 'cancelling' });
    try { await this.cancelRemote(id); if (inactive) this.update(id, { phase: 'cancelled', error: undefined, checkpoint: false }); }
    catch (error) {
      if (this.jobs.find(job => job.id === id)?.phase === 'cancelling') this.update(id, { phase: inactive ? (job.phase === 'queued' ? 'interrupted' : job.phase) : 'running', error: '取消失败：' + String(error) });
      this.reportError(String(error));
    }
  }
  async pause(id: string) {
    const job = this.jobs.find(job => job.id === id);
    if (!job) return;
    if (job.phase === 'queued') { this.update(id, { phase: 'paused' }); return; }
    if (job.phase !== 'running') return;
    this.update(id, { phase: 'pausing' });
    try { await this.pauseRemote(id); }
    catch (error) { if (this.jobs.find(job => job.id === id)?.phase === 'pausing') this.update(id, { phase: 'running' }); this.reportError(String(error)); }
  }
  resume(id: string) {
    const job = this.jobs.find(job => job.id === id);
    if (!job || !['paused', 'interrupted'].includes(job.phase)) return;
    if (!this.available(job.tabId)) { this.reportError('请在原标签重新连接，再继续传输'); return; }
    this.update(id, { phase: 'queued', error: undefined }); void this.pump();
  }
  stopTab(tabId: string, retainTransfers = false) {
    this.blocked.add(tabId); this.epochs.set(tabId, this.epoch(tabId) + 1);
    for (const job of this.jobs.filter(job => job.tabId === tabId)) {
      if (retainTransfers && (job.checkpoint || ['running', 'pausing', 'paused', 'interrupted'].includes(job.phase)) && !finished(job)) {
        if (['running', 'pausing'].includes(job.phase)) this.update(job.id, { phase: 'pausing' });
      } else void this.cancel(job.id);
    }
    this.emit();
  }
  async discardTab(tabId: string) {
    this.stopTab(tabId);
    return new Promise<boolean>(resolve => {
      const check = () => {
        const jobs = this.jobs.filter(job => job.tabId === tabId);
        if (jobs.some(job => ['running', 'pausing', 'cancelling'].includes(job.phase))) return;
        this.settled.delete(check); resolve(jobs.every(finished));
      };
      this.settled.add(check); check();
    });
  }
  cancelAll() { for (const job of this.jobs) void this.cancel(job.id); }
  private async pump() {
    if (this.active) return;
    this.active = true;
    try {
      let next: TransferJob | undefined;
      while ((next = this.jobs.find(job => job.phase === 'queued'))) {
        const job = next;
        if (!this.available(job.tabId)) { await this.cancel(job.id); continue; }
        this.update(job.id, { phase: 'running', started: Date.now(), initialBytes: job.progress?.transferred || 0 });
        let firstProgress = true;
        try {
          await this.execute(job, progress => {
            const current = this.jobs.find(item => item.id === job.id);
            if (!current || !['running', 'pausing', 'cancelling'].includes(current.phase)) return;
            // Retry early cancellation after IPC has registered the task.
            if (firstProgress && current.phase === 'cancelling') void this.cancelRemote(job.id).catch(error => this.reportError(String(error)));
            if (firstProgress && current.phase === 'pausing' && this.available(job.tabId)) void this.pauseRemote(job.id).catch(error => this.reportError(String(error)));
            const first = firstProgress; firstProgress = false; this.update(job.id, { progress, ...(first ? { initialBytes: progress.transferred } : {}) });
          });
          this.update(job.id, { phase: 'done', checkpoint: false }); this.completed(job);
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          const cancelling = this.jobs.find(item => item.id === job.id)?.phase === 'cancelling';
          const recoverable = text.startsWith('可恢复：') || (!!job.checkpoint && text !== '传输已取消');
          if (cancelling && (recoverable || text === '传输已暂停')) {
            try { await this.cancelRemote(job.id); }
            catch (error) { this.update(job.id, { phase: 'interrupted', checkpoint: true, error: '取消失败：' + String(error) }); this.reportError(String(error)); continue; }
          }
          const phase = cancelling && (recoverable || text === '传输已暂停') ? 'cancelled'
            : text === '传输已暂停' ? 'paused' : recoverable ? 'interrupted' : text === '传输已取消' ? 'cancelled' : 'error';
          this.update(job.id, { phase, checkpoint: ['paused', 'interrupted'].includes(phase), error: ['cancelled', 'paused'].includes(phase) ? undefined : text.replace(/^可恢复：/, '') });
        }
      }
    } finally { this.active = false; }
  }
}
