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
    const callbacks = new Map(), terminals = new Map(), pending = new Map(), checkpoints = new Map(); let callbackId = 0;
    window.transferCalls = []; window.cancelCalls = []; window.dialogCalls = []; window.pickResult = null; window.holdDialog = false; window.maxParallel = 0; window.nextError = ''; window.cleanupError = ''; window.checkpointCount = () => checkpoints.size;
    window.verifying = () => { const task = pending.values().next().value; task.args.channel.onmessage({name:task.name,transferred:200000,total:1000000,stage:'verifying'}); };
    window.finish = (error = '') => { const [id, task] = pending.entries().next().value; pending.delete(id); if (error) task.reject(error); else { checkpoints.delete(id); task.args.channel.onmessage({name:task.name,transferred:1000000,total:1000000}); task.resolve(task.name); } };
    window.__TAURI_INTERNALS__ = {
      metadata:{currentWindow:{label:'main'}}, transformCallback(fn) { callbacks.set(++callbackId,fn);return callbackId; }, unregisterCallback(id) { callbacks.delete(id); },
      async invoke(cmd, args) {
        if (cmd === 'load_config') return localStorage.getItem('queue-config');
        if (cmd === 'save_config') { localStorage.setItem('queue-config',args.json);return; }
        if (cmd === 'plugin:window|set_theme' || cmd === 'terminal_resize' || cmd === 'terminal_input') return;
        if (cmd === 'start_terminal') { terminals.set(args.id,args.channel); args.channel.onmessage({type:'connected'}); return; }
        if (cmd === 'terminal_close') {
          for (const [id, task] of pending) if (task.args.id === args.id) {
            checkpoints.set(id,200000); pending.delete(id); task.reject('可恢复：连接已断开');
          }
          terminals.get(args.id)?.onmessage({type:'closed'}); return;
        }
        if (cmd === 'list_remote') return [{name:'folder',size:0,isDir:true},{name:'alpha.txt',size:1000000,isDir:false},{name:'beta.txt',size:1000000,isDir:false}];
        if (cmd === 'plugin:dialog|open' || cmd === 'plugin:dialog|save') {
          window.dialogCalls.push({cmd,args});
          if (window.holdDialog) return new Promise(resolve => { window.resolveDialog = resolve; });
          return window.pickResult;
        }
        if (['upload_remote','download_remote','download_remote_batch'].includes(cmd)) {
          window.transferCalls.push({cmd,id:args.id,transferId:args.transferId,localPath:args.localPath,remotePath:args.remotePath,remoteDir:args.remoteDir,targetDir:args.targetDir,resumable:args.resumable});
          if (window.nextError) { const error = window.nextError; window.nextError = ''; throw error; }
          return new Promise((resolve,reject) => {
            const name = (args.localPath || args.remotePath).split(/[\\/]/).pop(); pending.set(args.transferId,{resolve,reject,args,name,download:cmd!=='upload_remote'});
            window.maxParallel = Math.max(window.maxParallel,pending.size);
            args.channel.onmessage({name,transferred:200000,total:1000000,temporaryPath:cmd==='upload_remote' ? '/.twb-upload-test.part' : undefined});
          });
        }
        if (cmd === 'pause_transfer') {
          const task = pending.get(args.transferId);
          if (task) { checkpoints.set(args.transferId,200000); pending.delete(args.transferId); task.reject('传输已暂停'); }
          return;
        }
        if (cmd === 'cancel_transfer') {
          if (window.cleanupError) throw window.cleanupError;
          checkpoints.delete(args.transferId);
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
  await pick(['C:/queue/alpha.txt','C:/queue/beta.txt']);
  await page.getByRole('button',{name:'上传',exact:true}).click(); await calls(1);
  const original = await page.evaluate(() => window.transferCalls[0]);
  if (!original.resumable) throw Error('Upload did not opt into checkpoint protocol');
  await row('上传 alpha.txt').getByRole('button',{name:'暂停',exact:true}).click(); await calls(2);
  await row('上传 alpha.txt').getByRole('status').filter({hasText:'已暂停'}).waitFor();
  await row('上传 alpha.txt').getByText('远端临时文件：/.twb-upload-test.part',{exact:true}).waitFor();
  await page.getByRole('button',{name:'服务器 b b.example:22',exact:true}).click();
  await row('上传 alpha.txt').getByRole('button',{name:'继续',exact:true}).click();
  await page.evaluate(() => window.finish()); await calls(3);
  const resumed = await page.evaluate(() => window.transferCalls[2]);
  for (const key of ['id','transferId','localPath','remoteDir']) if(resumed[key]!==original[key]) throw Error('Upload retargeted '+key);
  await row('上传 alpha.txt').getByRole('button',{name:'暂停',exact:true}).click();
  await row('上传 alpha.txt').getByRole('status').filter({hasText:'已暂停'}).waitFor();
  await page.getByRole('button',{name:'清除已结束',exact:true}).click();
  if (await row('上传 beta.txt').count()) throw Error('Ended task was not cleared');
  await page.getByRole('tab',{name:'服务器 a',exact:true}).click();
  await page.getByRole('button',{name:'断开',exact:true}).click();
  if (!await row('上传 alpha.txt').getByRole('button',{name:'继续',exact:true}).isDisabled()) throw Error('Offline resume enabled');
  await page.evaluate(() => { window.cleanupError='SFTP 未就绪；未清理 /.twb-upload-test.part，请重连后重试'; });
  await page.getByRole('button',{name:'关闭 服务器 a',exact:true}).click();
  await row('上传 alpha.txt').getByRole('alert').filter({hasText:'未清理'}).waitFor();
  if (await page.getByRole('tab',{name:'服务器 a',exact:true}).count()!==1) throw Error('Failed cleanup lost original tab');
  await page.screenshot({path:'artifacts/v090-upload-dark.png'});
  await page.getByRole('button',{name:'设置',exact:true}).click(); await page.getByLabel('主题').selectOption('light'); await page.getByRole('button',{name:'完成',exact:true}).click();
  await page.screenshot({path:'artifacts/v090-upload-light.png'});
  await page.setViewportSize({width:600,height:760}); await page.screenshot({path:'artifacts/v090-upload-narrow.png'});
  const bounds=await row('上传 alpha.txt').boundingBox(); if(bounds.x<0||bounds.x+bounds.width>601) throw Error('Narrow upload row overflows');
  await page.setViewportSize({width:1440,height:900});
  await page.evaluate(() => {window.cleanupError='';});
  await page.getByRole('button',{name:'重新连接',exact:true}).click(); await page.getByText('已连接',{exact:true}).waitFor(); await calls(3);
  await row('上传 alpha.txt').getByRole('button',{name:'继续',exact:true}).click(); await calls(4);
  await page.evaluate(() => window.verifying()); await row('上传 alpha.txt').getByRole('status').filter({hasText:'校验文件中'}).waitFor();
  await page.evaluate(() => window.finish('可恢复：本地源文件内容已改变，未续传；临时路径：/.twb-upload-test.part'));
  await row('上传 alpha.txt').getByRole('alert').filter({hasText:'本地源文件内容已改变'}).waitFor();
  await row('上传 alpha.txt').getByRole('button',{name:'取消传输',exact:true}).click();
  await row('上传 alpha.txt').getByRole('status').filter({hasText:'已取消'}).waitFor();
  if (await page.evaluate(() => window.checkpointCount())!==0) throw Error('Paused cancellation leaked checkpoint');
  await page.getByRole('button',{name:'收起',exact:true}).click();
  await pick(['C:/queue/active.txt']); await page.getByRole('button',{name:'上传',exact:true}).click(); await calls(5);
  await page.getByRole('button',{name:'关闭 服务器 a',exact:true}).click();
  await row('上传 active.txt').getByRole('status').filter({hasText:'已取消'}).waitFor();
  await page.getByRole('tab',{name:'服务器 a',exact:true}).waitFor({state:'detached'});
  if (await page.evaluate(() => window.maxParallel>1)) throw Error('Upload overlapped another transfer');
  const config=await page.evaluate(() => localStorage.getItem('queue-config'));
  if(config.includes('C:/queue')||config.includes('twb-upload-test')||config.includes('transferId')) throw Error('Upload checkpoints persisted');
  if(errors.length) throw Error(errors.join('\n'));
  console.log('Upload pause/slot release/manual resume/session binding, temporary path, offline cleanup retry/tab retention, source change, active close cleanup, themes/narrow/memory-only: passed.');
  await browser.close();
})().catch(error => {console.error(error);process.exit(1);});
