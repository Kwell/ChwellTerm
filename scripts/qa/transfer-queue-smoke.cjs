const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'); fs.mkdirSync('artifacts', { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.isTauri = true;
    const seed = { version: 1, sessions: ['a','b'].map(id => ({id,name:'服务器 '+id,host:id+'.example',port:22,username:'dev',environment:'development',auth:'agent',keyPath:'',kind:'ssh'})), snippets: [], settings: { theme:'dark',fontSize:13,fontFamily:'Consolas, monospace',scrollback:10000 } };
    if (!localStorage.getItem('queue-config')) localStorage.setItem('queue-config', JSON.stringify(seed));
    const callbacks = new Map(), terminals = new Map(), pending = new Map(); let callbackId = 0;
    window.transferCalls = []; window.cancelCalls = []; window.dialogCalls = []; window.pickResult = null; window.holdDialog = false; window.maxParallel = 0;
    window.finish = (error = '') => { const [id, task] = pending.entries().next().value; pending.delete(id); if (error) task.reject(error); else { task.args.channel.onmessage({name:task.name,transferred:1000000,total:1000000}); task.resolve(task.name); } };
    window.__TAURI_INTERNALS__ = {
      metadata:{currentWindow:{label:'main'}}, transformCallback(fn) { callbacks.set(++callbackId,fn);return callbackId; }, unregisterCallback(id) { callbacks.delete(id); },
      async invoke(cmd, args) {
        if (cmd === 'load_config') return localStorage.getItem('queue-config');
        if (cmd === 'save_config') { localStorage.setItem('queue-config',args.json);return; }
        if (cmd === 'plugin:window|set_theme' || cmd === 'terminal_resize' || cmd === 'terminal_input') return;
        if (cmd === 'start_terminal') { terminals.set(args.id,args.channel); args.channel.onmessage({type:'connected'}); return; }
        if (cmd === 'terminal_close') { terminals.get(args.id)?.onmessage({type:'closed'}); return; }
        if (cmd === 'list_remote') return [{name:'folder',size:0,isDir:true},{name:'alpha.txt',size:1000000,isDir:false},{name:'beta.txt',size:1000000,isDir:false}];
        if (cmd === 'plugin:dialog|open' || cmd === 'plugin:dialog|save') {
          window.dialogCalls.push({cmd,args});
          if (window.holdDialog) return new Promise(resolve => { window.resolveDialog = resolve; });
          return window.pickResult;
        }
        if (['upload_remote','download_remote','download_remote_batch'].includes(cmd)) {
          window.transferCalls.push({cmd,id:args.id,transferId:args.transferId,localPath:args.localPath,remotePath:args.remotePath,remoteDir:args.remoteDir,targetDir:args.targetDir});
          return new Promise((resolve,reject) => {
            const name = (args.localPath || args.remotePath).split(/[\\/]/).pop(); pending.set(args.transferId,{resolve,reject,args,name});
            window.maxParallel = Math.max(window.maxParallel,pending.size);
            args.channel.onmessage({name,transferred:200000,total:1000000});
          });
        }
        if (cmd === 'cancel_transfer') {
          window.cancelCalls.push(args.transferId);
          const task = pending.get(args.transferId);
          if (task && !task.cancelling) { task.cancelling = true; setTimeout(() => { pending.delete(args.transferId); task.reject('传输已取消'); },150); }
          return;
        }
        throw Error('Unexpected mock command '+cmd);
      }
    };
  });
  const row = name => page.getByRole('article', {name,exact:true});
  const calls = async count => { await page.waitForFunction(n => window.transferCalls.length === n, count); };
  const pick = value => page.evaluate(value => { window.pickResult = value; }, value);
  await page.goto(process.env.WORKBENCH_PREVIEW_URL || 'http://127.0.0.1:1421');
  await page.getByRole('button',{name:'服务器 a a.example:22',exact:true}).click();
  await page.getByLabel('选择 alpha.txt').waitFor();
  await pick(['C:/queue/a.txt','C:/queue/b.txt','C:/queue/c.txt']); await page.getByRole('button',{name:'上传',exact:true}).click(); await calls(1);
  await row('上传 b.txt').getByRole('button',{name:'取消等待'}).click();
  if ((await page.evaluate(() => window.cancelCalls)).length) throw Error('Waiting cancel called backend');
  await page.getByLabel('全选当前目录文件').check();
  if (!await page.getByRole('button',{name:'编辑',exact:true}).isDisabled()) throw Error('Multi-selection allowed editing');
  if (await page.getByLabel('选择 folder').count()) throw Error('Directory selectable for file download');
  await pick('C:/queue/downloads'); await page.getByRole('button',{name:'下载',exact:true}).click();
  await row('下载 beta.txt').waitFor();
  await page.getByLabel('远程目录').fill('/changed');
  await page.getByLabel('选择 alpha.txt').waitFor();
  if (await page.getByLabel('选择 alpha.txt').isChecked()) throw Error('Selection survived directory change');
  await page.getByRole('button',{name:'服务器 b b.example:22',exact:true}).click();
  await pick(['C:/queue/other.txt']); await page.getByRole('button',{name:'上传',exact:true}).click(); await row('上传 other.txt').waitFor();
  await page.getByRole('button',{name:/传输队列 ·/}).click();
  if (await row('上传 a.txt').count()) throw Error('Queue collapse failed');
  await page.getByRole('button',{name:/传输队列 ·/}).click();
  await page.screenshot({path:'artifacts/v070-queue-dark.png'});
  await page.evaluate(() => window.finish()); await calls(2);
  await page.evaluate(() => window.finish('远程已有同名文件')); await calls(3);
  await row('上传 c.txt').getByRole('status').filter({hasText:'传输失败'}).waitFor();
  await page.evaluate(() => window.finish()); await calls(4);
  await page.evaluate(() => window.finish()); await calls(5);
  const records = await page.evaluate(() => window.transferCalls);
  if (records[2].cmd !== 'download_remote_batch' || records[2].remotePath !== '/alpha.txt' || records[3].remotePath !== '/beta.txt' || records[2].targetDir !== 'C:/queue/downloads' || records[2].id !== records[0].id) throw Error('Batch download lost captured targets');
  if (records[4].id === records[0].id || records[4].remoteDir !== '/') throw Error('New session queue misbound');
  await row('上传 other.txt').getByRole('button',{name:'取消传输'}).click();
  await row('上传 other.txt').getByRole('status').filter({hasText:'已取消'}).waitFor();
  await page.getByRole('button',{name:'收起',exact:true}).click();
  if (await page.getByRole('region',{name:'传输队列'}).count()) throw Error('Ended queue not cleared');
  await page.getByLabel('选择 alpha.txt').check(); await pick('C:/queue/renamed.txt');
  await page.getByRole('button',{name:'下载',exact:true}).click(); await calls(6);
  const single = await page.evaluate(() => window.transferCalls[5]);
  if (single.cmd !== 'download_remote' || single.localPath !== 'C:/queue/renamed.txt' || single.remotePath !== '/alpha.txt') throw Error('Single-file save target changed');
  await page.evaluate(() => window.finish()); await row('下载 alpha.txt').getByRole('status').filter({hasText:'传输完成'}).waitFor();
  await page.getByRole('button',{name:'收起',exact:true}).click();
  console.log('Multi-upload, checkbox downloads, serial failure continuation, cancellation, captured session/paths, selection reset, collapse: passed.');

  await page.getByRole('tab',{name:'服务器 a',exact:true}).click();
  await pick(['C:/queue/closing.txt','C:/queue/never.txt']); await page.getByRole('button',{name:'上传',exact:true}).click(); await calls(7);
  await page.getByRole('tab',{name:'服务器 b',exact:true}).click();
  await pick(['C:/queue/survivor.txt']); await page.getByRole('button',{name:'上传',exact:true}).click(); await row('上传 survivor.txt').waitFor();
  await page.getByRole('button',{name:'关闭 服务器 a',exact:true}).click();
  await row('上传 never.txt').getByRole('status').filter({hasText:'已取消'}).waitFor(); await calls(8);
  if ((await page.evaluate(() => window.transferCalls[7])).localPath !== 'C:/queue/survivor.txt') throw Error('Closed session task started');
  await page.evaluate(() => window.finish());
  await row('上传 survivor.txt').getByRole('status').filter({hasText:'传输完成'}).waitFor();
  console.log('Closing source cancels its waiting/running tasks; unrelated session continues after cleanup: passed.');
  await pick(null); await page.getByRole('button',{name:'上传',exact:true}).click();
  await page.waitForTimeout(100); await calls(8);
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByLabel('主题').selectOption('light'); await page.getByRole('button',{name:'完成',exact:true}).click();
  await page.screenshot({path:'artifacts/v070-queue-light.png'});
  await page.setViewportSize({width:600,height:760});
  const queue = page.getByRole('region',{name:'传输队列'}); const bounds = await queue.boundingBox();
  if (bounds.x < 0 || bounds.x + bounds.width > 601) throw Error('Narrow queue overflow');
  await page.screenshot({path:'artifacts/v070-queue-narrow.png'}); await page.setViewportSize({width:1440,height:900});
  await page.evaluate(() => { window.holdDialog = true; }); await page.getByRole('button',{name:'上传',exact:true}).click();
  await page.waitForFunction(() => !!window.resolveDialog);
  await page.getByRole('button',{name:'关闭 服务器 b',exact:true}).click();
  await page.evaluate(() => window.resolveDialog(['C:/queue/stale.txt']));
  await page.getByText('选择文件期间源会话已断开，请重新选择',{exact:true}).waitFor(); await calls(8);
  if (await page.evaluate(() => window.maxParallel > 1)) throw Error('Overlapping backend transfers');
  const config = await page.evaluate(() => localStorage.getItem('queue-config'));
  if (config.includes('C:/queue') || config.includes('survivor.txt') || config.includes('transferId')) throw Error('Runtime transfer queue persisted');
  if (errors.length) throw Error(errors.join('\n'));
  console.log('Dialog cancel/stale selection, dark/light/narrow UI, runtime-only queue and no overlap/errors: passed.');
  await browser.close();
})().catch(error => { console.error(error); process.exit(1); });
