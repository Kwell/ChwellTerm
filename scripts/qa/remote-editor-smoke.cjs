const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
fs.mkdirSync('artifacts', { recursive: true });

(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const seed = { version: 1, sessions: [
      { id: 'local', name: '本地终端', host: '', port: 22, username: '', environment: 'personal', auth: 'key', keyPath: '', kind: 'local' },
      { id: 'api', name: '开发 API', host: 'api.example', port: 22, username: 'dev', environment: 'development', auth: 'agent', keyPath: '', kind: 'ssh' }
    ], snippets: [], settings: { theme: 'dark', fontSize: 13, fontFamily: 'Consolas, monospace', scrollback: 10000 } };
    if (!localStorage.getItem('workspace-test-config')) localStorage.setItem('workspace-test-config', JSON.stringify(seed));
    window.remoteContent = '\uFEFF中文\r\noriginal\r\n'; window.remoteRevision = 1; window.readCalls = []; window.saveCalls = []; window.saveFailure = ''; window.readDelay = 0;
    window.disconnect = () => { for (const channel of terminals.values()) channel.onmessage({type:'closed'}); };
    window.interruptEdit = () => { terminals.values().next().value.onmessage({type:'fingerprint',host:'test-host',requestId:'fp-test',fingerprint:'SHA256:test'}); };
    window.isTauri = true; window.startCalls = []; window.inputCalls = [];
    const callbacks = new Map(), terminals = new Map(); let nextId = 0;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback(fn) { callbacks.set(++nextId, fn); return nextId; }, unregisterCallback(id) { callbacks.delete(id); },
      async invoke(command, args) {
        if (command === 'load_config') return localStorage.getItem('workspace-test-config');
        if (command === 'save_config') { localStorage.setItem('workspace-test-config', args.json); return; }
        if (command === 'plugin:window|set_theme' || command === 'terminal_resize') return;
        if (command === 'trust_host') return;
        if (command === 'start_terminal') {
          window.startCalls.push(structuredClone({ id: args.id, session: args.session, credentials: args.credentials }));
          terminals.set(args.id, args.channel);
          args.channel.onmessage({ type: 'connected' });
          args.channel.onmessage({ type: 'data', data: btoa('TRANSCRIPT_PRIVATE_MARKER\r\n') });
          return;
        }
        if (command === 'terminal_input') { window.inputCalls.push(args); return; }
        if (command === 'terminal_close') { terminals.get(args.id)?.onmessage({ type: 'closed' }); return; }
        if (command === 'list_remote') return [{name:'config.txt',size:64,isDir:false},{name:'binary.bin',size:10,isDir:false},{name:'large.txt',size:2000000,isDir:false},{name:'folder',size:0,isDir:true}];
        if (command === 'read_remote_text') {
          window.readCalls.push(structuredClone(args));
          if (window.readDelay) await new Promise(r=>setTimeout(r,window.readDelay));
          if (args.path.endsWith('binary.bin')) throw '此文件包含二进制内容，请下载后使用对应工具打开';
          if (args.path.endsWith('large.txt')) throw '仅支持不超过 1 MiB 的文本文件，请下载后编辑';
          return {content:window.remoteContent,revision:String(window.remoteRevision)};
        }
        if (command === 'save_remote_text') {
          window.saveCalls.push(structuredClone(args));
          if (window.saveFailure) throw window.saveFailure;
          if (args.revision !== String(window.remoteRevision)) throw '远端文件已被修改，未覆盖。请复制当前草稿，再重新读取远端内容';
          await new Promise(r=>setTimeout(r,80));
          window.remoteContent = args.content; window.remoteRevision++;
          return {document:{content:args.content,revision:String(window.remoteRevision)},backupPath:'/.twb-test.bak'};
        }
        throw Error('Unexpected mock command: ' + command);
      }
    };
  });
  await page.goto(process.env.WORKBENCH_PREVIEW_URL || 'http://127.0.0.1:1421');
  await page.getByRole('button', {name:'开发 API api.example:22',exact:true}).click();
  const row = name => page.locator('.file-row').filter({hasText:name});
  await row('config.txt').click(); await page.getByRole('button',{name:'编辑',exact:true}).click();
  const dialog=page.getByRole('dialog'), input=dialog.getByLabel('远程文件内容'), save=dialog.getByRole('button',{name:'保存到远端',exact:true});
  await input.waitFor();
  await page.waitForFunction(()=>document.querySelector('.remote-editor-text')?.value.includes('original'));
  if(await save.isEnabled()) throw Error('Unchanged document can save');
  if(await dialog.getByLabel('换行格式').inputValue()!=='crlf') throw Error('Original newline not detected');
  await input.fill('中文编辑\nnew line\n'); await page.keyboard.press('Control+s');
  await dialog.getByText('已保存到远端，原内容已备份。',{exact:true}).waitFor();
  const saved=await page.evaluate(()=>window.saveCalls.at(-1));
  if(saved.content!=='\uFEFF中文编辑\r\nnew line\r\n') throw Error('BOM or CRLF lost');
  if(saved.id!==(await page.evaluate(()=>window.startCalls[0].id)) || saved.path!=='/config.txt') throw Error('Wrong edit target');
  await dialog.getByText('上次备份：').waitFor();
  await input.fill('draft kept'); await page.keyboard.press('Escape');
  await dialog.getByRole('button',{name:'保留草稿',exact:true}).click();
  if(await input.inputValue()!=='draft kept') throw Error('Draft discarded without consent');
  await page.evaluate(()=>window.interruptEdit());
  await page.getByRole('dialog',{name:'首次连接 · 确认服务器身份',exact:true}).getByRole('button',{name:'信任并连接',exact:true}).click();
  if(await input.inputValue()!=='draft kept') throw Error('Another tab authentication destroyed editor draft');
  await page.evaluate(()=>{window.remoteContent='externally changed\n';window.remoteRevision++;});
  await save.click(); await dialog.getByRole('alert').filter({hasText:'远端文件已被修改'}).waitFor();
  if(await input.inputValue()!=='draft kept') throw Error('Conflict discarded draft');
  await dialog.getByRole('button',{name:'重新读取',exact:true}).click();
  await dialog.getByRole('button',{name:'保留草稿',exact:true}).click();
  await dialog.getByRole('button',{name:'重新读取',exact:true}).click();
  await dialog.getByRole('button',{name:'丢弃并重新读取',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.remote-editor-text')?.value==='externally changed\n');
  await input.fill('failed save draft'); await page.evaluate(()=>window.saveFailure='服务器拒绝替换文件');
  await save.click(); await dialog.getByRole('alert').filter({hasText:'服务器拒绝替换文件'}).waitFor();
  if(await input.inputValue()!=='failed save draft') throw Error('Failed save discarded draft');
  await page.screenshot({path:'artifacts/v050-editor-dark-conflict.png'});
  await input.fill('中'.repeat(350000));
  await dialog.getByRole('alert').filter({hasText:'编辑内容超过 1 MiB'}).waitFor();
  if(await save.isEnabled()) throw Error('Oversized UTF-8 save allowed');
  await input.fill('draft'); await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  await dialog.getByRole('button',{name:'丢弃并关闭',exact:true}).click();
  for(const name of ['binary.bin','large.txt']) {
    await row(name).dblclick(); await dialog.getByRole('alert').waitFor();
    if(await save.isEnabled()) throw Error('Unsupported document can save');
    await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  }
  await page.getByRole('button',{name:'设置',exact:true}).click(); await page.getByLabel(/^主题/).selectOption('light');
  await dialog.getByRole('button',{name:'完成',exact:true}).click();
  await page.evaluate(()=>{window.saveFailure='';window.readDelay=300;});
  await row('config.txt').dblclick();
  if(await dialog.getByRole('button',{name:'关闭对话框',exact:true}).isEnabled()) throw Error('Loading editor does not guard pending read');
  await page.waitForFunction(()=>!document.querySelector('.remote-editor-text')?.disabled);
  await input.fill('保存成功\n'); await page.keyboard.press('Meta+s'); await dialog.getByText('已保存到远端，原内容已备份。',{exact:true}).waitFor();
  await page.screenshot({path:'artifacts/v050-editor-light.png'});
  await page.setViewportSize({width:768,height:707}); await page.screenshot({path:'artifacts/v050-editor-narrow.png'});
  await input.fill('disconnected draft'); await page.evaluate(()=>window.disconnect());
  await dialog.getByText(/连接已断开，草稿保留/).waitFor();
  if(await save.isEnabled() || await input.inputValue()!=='disconnected draft') throw Error('Disconnected editor lost draft or allows save');
  if((await page.evaluate(()=>localStorage.getItem('workspace-test-config'))).includes('disconnected draft')) throw Error('Remote draft leaked to config');
  await page.keyboard.press('Escape'); await dialog.getByRole('button',{name:'丢弃并关闭',exact:true}).click();
  if(errors.length) throw Error(errors.join('\n'));
  console.log('Remote editor: target binding, BOM/CRLF, save shortcut, exact backup path, dirty close/reload, conflicts, failed saves, binary/large file rejection, UTF-8 byte limit, loading guard, disconnected draft, themes and resize passed (mock IPC).');
  await browser.close();
})().catch(error=>{console.error(error);process.exit(1);});
