import { useState } from 'react';
import { ChevronDown, Upload, Download } from 'lucide-react';
import type { TransferJob } from './transferQueue';
function bytes(value: number) { return value >= 1024 * 1024 ? `${(value / (1024 * 1024)).toFixed(1)} MB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} B`; }
export function TransferStatus({ jobs, onCancel, onPause, onResume, canResume, onCancelAll, onDismiss }: { jobs: TransferJob[]; onCancel: (id: string) => void; onPause: (id: string) => void; onResume: (id: string) => void; canResume: (tabId: string) => boolean; onCancelAll: () => void; onDismiss: () => void }) {
  const [expanded, setExpanded] = useState(true);
  const waiting = jobs.filter(job => job.phase === 'queued').length;
  const busy = jobs.some(job => ['queued', 'running', 'pausing', 'paused', 'interrupted', 'cancelling'].includes(job.phase));
  const ended = jobs.filter(job => ['done', 'cancelled', 'error'].includes(job.phase)).length;
  const labels = { queued: '等待中', running: '传输中', pausing: '正在保存断点', paused: '已暂停', interrupted: '已中断，可继续', cancelling: '正在取消并清理', done: '传输完成', cancelled: '已取消', error: '传输失败' };
  return <section className="transfer-queue" aria-label="传输队列">
    <div className="transfer-queue-heading"><button aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><ChevronDown size={15} />传输队列 · {jobs.length} 项</button><span>{waiting} 项等待 · {ended} 项已结束</span><div>{busy && <button onClick={onCancelAll}>全部取消</button>}{ended > 0 && <button onClick={onDismiss}>{busy ? '清除已结束' : '收起'}</button>}</div></div>
    {expanded && <div className="transfer-queue-list">{jobs.map(job => {
      const progress = job.progress, total = progress?.total;
      const percent = total && progress ? Math.min(100, Math.floor(progress.transferred / total * 100)) : job.phase === 'done' ? 100 : 0;
      const speed = progress ? Math.max(0, progress.transferred - (job.initialBytes || 0)) / Math.max(0.1, (Date.now() - job.started) / 1000) : 0;
      const checking = job.phase === 'running' && progress?.stage === 'verifying';
      return <article className={`transfer-status ${job.phase}`} key={job.id} aria-label={`${job.direction === 'upload' ? '上传' : '下载'} ${job.name}`}>
        <div className="transfer-job-title">{job.direction === 'upload' ? <Upload size={14} /> : <Download size={14} />}<strong>{job.name}</strong><span>{job.sessionName}</span><span role="status">{checking ? '校验文件中' : labels[job.phase]}</span>{(job.phase === 'queued' || job.phase === 'running') && <button onClick={() => onPause(job.id)}>暂停</button>}{['paused', 'interrupted'].includes(job.phase) && <button disabled={!canResume(job.tabId)} title={!canResume(job.tabId) ? '请在原标签重新连接' : '校验文件后继续'} onClick={() => onResume(job.id)}>继续</button>}{['queued', 'running', 'pausing', 'paused', 'interrupted', 'cancelling'].includes(job.phase) && <button disabled={job.phase === 'cancelling'} onClick={() => onCancel(job.id)}>{job.phase === 'queued' ? '取消等待' : '取消传输'}</button>}</div>
        <p className="transfer-target" title={`${job.localPath} ${job.direction === 'upload' ? '→' : '←'} ${job.remotePath}`}>{job.direction === 'upload' ? `目标目录：${job.remotePath}` : `来源：${job.remotePath} · 保存至：${job.localPath}`}</p>
        {progress && <><progress aria-label="文件传输进度" max={100} value={total != null ? percent : job.phase === 'done' ? 100 : undefined} /><span className="subtle">{bytes(progress.transferred)} / {total == null ? '未知大小' : bytes(total)}{job.phase === 'running' && !checking && ` · ${bytes(speed)}/s`}</span></>}
        {['paused', 'interrupted'].includes(job.phase) && <p className="subtle">断点仅保留在本次运行中；继续前会校验文件内容。{job.direction === 'upload' && '远端临时文件在取消时清理；退出后可能保留。'}{!canResume(job.tabId) && '请在原标签重新连接。'}</p>}
        {job.direction === 'upload' && job.checkpoint && progress?.temporaryPath && <p className="transfer-target" title={progress.temporaryPath}>远端临时文件：{progress.temporaryPath}</p>}
        {job.error && <p className="error-message" role="alert">{job.error}</p>}
      </article>;
    })}</div>}
  </section>;
}
