const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
require('node:fs').mkdirSync('artifacts', {recursive:true});
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.isTauri = true;
    const callbacks = new Map(), terminals = new Map(), transfers = new Map(); let nextId = 0;
    window.resizeCalls = []; window.themeCalls = []; window.startCalls = []; const pendingTrust = new Map(), pendingAuth = new Map(); window.authResponses = [];
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback(fn) { callbacks.set(++nextId, fn); return nextId; }, unregisterCallback(id) { callbacks.delete(id); },
      async invoke(cmd, args) {
        if (cmd === 'load_config') return localStorage.getItem('test-config');
        if (cmd === 'save_config') { localStorage.setItem('test-config', args.json); return; }
        if (cmd === 'plugin:window|set_theme') { window.themeCalls.push(args.value); return; }
        if (cmd === 'start_terminal') {
          window.startCalls.push(args); terminals.set(args.id, args.channel);
          const emit = event => args.channel.onmessage(event);
          emit({type:'diagnostic',data:args.session.jump ? '跳板机 · TCP 连接' : '目标服务器 · TCP 连接'});
          if (args.session.auth === 'keyboard-interactive') {
            let round = 0;
            const advance = answers => {
              if (answers === null) { emit({type:'closed'}); return; }
              if (round === 3) { emit({type:'connected'}); return; }
              const requestId = args.id + ':otp:' + round;
              pendingAuth.set(requestId, advance);
              emit({type:'auth-challenge',requestId,host:'[otp.example]:22',challenge:{role:'目标服务器',username:'otpuser',name:round===0?'认证说明':'服务器认证',instructions:'请按照服务器提示完成登录',prompts:round===0?[]:round===1?[{prompt:'Account:',echo:true},{prompt:'Password:',echo:false}]:[{prompt:'[OTP Code]:',echo:false}]}});
              round++;
            };
            advance([]); return;
          }
          if (args.session.jump) {
            const advance = accepted => {
              if (!accepted) { emit({type:'error',data:'指纹被拒绝，连接已停止'}); return; }
              const requestId = args.id + ':target';
              pendingTrust.set(requestId, accept => { if (accept) { emit({type:'diagnostic',data:'目标服务器 · 认证'}); emit({type:'diagnostic',data:'SFTP 已就绪'}); emit({type:'connected'}); } else emit({type:'error',data:'目标指纹被拒绝'}); });
              emit({type:'fingerprint',requestId,host:'['+args.session.host+']:'+args.session.port,fingerprint:'SHA256:TARGET'});
            };
            const requestId = args.id + ':jump'; pendingTrust.set(requestId, advance);
            emit({type:'fingerprint',requestId,host:'['+args.session.jump.host+']:'+args.session.jump.port,fingerprint:'SHA256:JUMP'});
          } else if (args.session.host === 'otp.example' && args.session.auth === 'key') emit({type:'error',data:'目标服务器：选择的是公钥，不能用于私钥认证；请选择对应的私钥文件'});
          else if (args.session.host === 'failure.example') emit({type:'error',data:'目标服务器：无法连接 SSH Agent'});
          else if (args.session.host !== 'slow.example') emit({type:'connected'});
          return;
        }
        if (cmd === 'respond_auth') { window.authResponses.push(structuredClone(args)); const next = pendingAuth.get(args.requestId); pendingAuth.delete(args.requestId); next(args.responses); return; }
        if (cmd === 'trust_host') { const next = pendingTrust.get(args.requestId); pendingTrust.delete(args.requestId); next(args.accept); return; }
        if (cmd === 'terminal_resize') { window.resizeCalls.push(args); return; }
        if (cmd === 'terminal_input') return;
        if (cmd === 'terminal_close') { terminals.get(args.id).onmessage({ type: 'closed' }); return; }
        if (cmd === 'list_remote') return [{name:'中文.txt',size:1000,isDir:false}];
        if (cmd === 'plugin:dialog|open') return 'C:/test/large.bin';
        if (cmd === 'plugin:dialog|save') return 'C:/test/download.txt';
        if (cmd === 'upload_remote' || cmd === 'download_remote') {
          return new Promise((resolve, reject) => {
            let transferred=0;
            args.channel.onmessage({name:'large.bin',transferred,total:10000000});
            const timer = setInterval(() => { transferred += 100000; args.channel.onmessage({name:'large.bin',transferred,total:10000000}); },100);
            transfers.set(args.transferId, { reject, timer });
          });
        }
        if (cmd === 'cancel_transfer') { const task = transfers.get(args.transferId); clearInterval(task.timer); transfers.delete(args.transferId); task.reject('传输已取消'); return; }
        throw Error('Unexpected mock command: ' + cmd);
      }
    };
  });
  await page.goto(process.env.WORKBENCH_PREVIEW_URL || 'http://127.0.0.1:1421');
  if (await page.getByText('云端项目').count()) throw Error('Placeholder remains');
  await page.getByRole('button', { name: '导入 / 导出', exact: true }).click();
  await page.getByRole('button', { name: '导入 OpenSSH config', exact: true }).click();
  await page.getByLabel('OpenSSH 配置').fill('Host api\n HostName api.example.com\n User dev\n PreferredAuthentications password\nHost blocked\n User dev\n ProxyJump gateway,other\nHost other\n HostName other.example.com\n User dev');
  await page.getByRole('button', { name: '预览会话', exact: true }).click();
  const checks = page.getByRole('dialog').getByRole('checkbox');
  if (!await checks.nth(1).isDisabled()) throw Error('Proxy host selectable');
  await checks.nth(2).uncheck();
  await page.screenshot({ path: 'artifacts/v03-import-preview.png' });
  await page.getByRole('button', { name: '导入所选会话（1）' }).click();
  await page.getByRole('button', { name: 'api api.example.com:22', exact: true }).waitFor();
  if (await page.getByRole('button', { name: 'other other.example.com:22', exact: true }).count()) throw Error('Unselected host imported');
  await page.reload(); await page.getByRole('button', { name: 'api api.example.com:22', exact: true }).waitFor();
  console.log('Import preview, unsupported proxy exclusion, selection and persistence: passed.');
  await page.getByRole('button', { name: '本地终端', exact: true }).click();
  await page.getByRole('button', { name: 'api api.example.com:22', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '连接', exact: true }).click();
  await page.getByText('已连接', { exact: true }).waitFor();
  await page.getByRole('button', { name: '切换分屏' }).click();
  const handle = page.getByRole('separator');
  const box = await handle.boundingBox();
  await page.mouse.move(box.x+3, box.y+100); await page.mouse.down(); await page.mouse.move(box.x+150, box.y+100); await page.mouse.up();
  if (Number(await handle.getAttribute('aria-valuenow')) <= 50) throw Error('Pointer split adjustment failed');
  await handle.focus(); await page.keyboard.press('Home');
  if (await handle.getAttribute('aria-valuenow') !== '20') throw Error('Keyboard split adjustment failed');
  let panes = page.locator('.terminal-pane.visible');
  const narrow = await panes.nth(1).boundingBox(), wide = await panes.nth(0).boundingBox();
  if (Math.abs(narrow.width / (narrow.width + wide.width) - 0.2) > 0.03) throw Error('Split widths do not reflect the selected ratio');
  await handle.dblclick();
  if (await handle.getAttribute('aria-valuenow') !== '50') throw Error('Split reset failed');
  await page.getByRole('button', { name: '切换分屏' }).click();
  await handle.focus(); await page.keyboard.press('ArrowDown');
  if (await handle.getAttribute('aria-valuenow') !== '55') throw Error('Vertical split adjustment failed');
  const firstHeight = (await panes.nth(1).boundingBox()).height, secondHeight = (await panes.nth(0).boundingBox()).height;
  if (Math.abs(firstHeight / (firstHeight + secondHeight) - 0.55) > 0.03) throw Error('Split heights do not reflect the selected ratio');
  await page.waitForTimeout(200);
  if (!(await page.evaluate(() => window.resizeCalls.length))) throw Error('Terminal resize was not invoked');
  console.log('Split pointer / keyboard / reset / resize: passed.');
  await page.getByRole('button', { name: '上传', exact: true }).click();
  await page.getByRole('progressbar', { name: '文件传输进度' }).waitFor();
  await page.waitForTimeout(350);
  const value = await page.getByRole('progressbar').getAttribute('value');
  if (Number(value)<=0) throw Error('Progress did not advance');
  await page.getByRole('button', { name: '显示或隐藏文件面板' }).click();
  await page.getByRole('tab', { name: '本地终端', exact: true }).click();
  if (!await page.getByRole('button', { name: '取消传输' }).isVisible()) throw Error('Transfer disappeared on tab switch');
  await page.screenshot({ path: 'artifacts/v03-transfer-progress.png' });
  await page.getByRole('button', { name: '取消传输' }).click();
  await page.getByText('已取消', { exact: true }).waitFor();
  console.log('Progress and cancellation across tab / panel changes (mock IPC): passed.');
  await page.getByRole('button', { name: '收起', exact: true }).click();
  for (const width of [1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    if (!await page.evaluate(() => document.documentElement.scrollWidth<=document.documentElement.clientWidth+1)) throw Error('Layout overflow at ' + width);
  }
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.evaluate(() => {
    const config = JSON.parse(localStorage.getItem('test-config'));
    config.sessions.find(s => s.kind === 'ssh').name = 'server-with-a-very-long-session-name-'.repeat(4);
    localStorage.setItem('test-config', JSON.stringify(config));
  });
  await page.reload();
  await page.getByRole('button', { name: /server-with-a-very-long-session-name/ }).first().waitFor();
  if (!await page.locator('.sidebar').evaluate(element => element.scrollWidth <= element.clientWidth + 1)) throw Error('Long session name caused sidebar overflow');
  if (errors.length) throw Error(errors.join('\n'));
  console.log('Responsive layout and runtime errors: passed.');
  await page.getByRole('button', { name: '新建连接', exact: true }).click();
  await page.getByLabel('会话名称', {exact:true}).fill('internal');
  await page.getByLabel('主机地址', {exact:true}).fill('10.0.0.5');
  await page.getByLabel('用户名', {exact:true}).fill('deploy');
  await page.getByLabel('通过跳板机连接', {exact:true}).check();
  await page.getByLabel('跳板机主机地址', {exact:true}).fill('gateway.example');
  await page.getByLabel('跳板机用户名', {exact:true}).fill('jumpuser');
  await page.getByLabel('跳板机认证方式', {exact:true}).selectOption('password');
  await page.screenshot({path:'artifacts/v03-jump-editor.png'});
  await page.getByRole('button', { name: '保存并连接', exact: true }).click();
  await page.getByLabel('密码', {exact:true}).fill('target-secret');
  await page.getByLabel('跳板机密码', {exact:true}).fill('jump-secret');
  await page.getByRole('dialog').getByRole('button', {name:'连接',exact:true}).click();
  await page.getByRole('dialog').getByText('[gateway.example]:22', {exact:true}).waitFor();
  await page.getByRole('button', {name:'信任并连接',exact:true}).click();
  await page.getByRole('dialog').getByText('[10.0.0.5]:22', {exact:true}).waitFor();
  await page.screenshot({path:'artifacts/v03-target-fingerprint.png'});
  await page.getByRole('button', {name:'信任并连接',exact:true}).click();
  await page.getByText('已连接', {exact:true}).waitFor();
  const secrets = await page.evaluate(() => {
    const last = window.startCalls.at(-1);
    return {target:last.credentials.password,jump:last.credentials.jump.password,config:localStorage.getItem('test-config')};
  });
  if (secrets.target !== 'target-secret' || secrets.jump !== 'jump-secret' || secrets.config.includes('secret')) throw Error('Independent credentials or config boundary failed');
  await page.getByRole('button', {name:'连接诊断',exact:true}).click();
  const diagnostic = await page.getByLabel('连接阶段').textContent();
  if (!diagnostic.includes('SFTP 已就绪') || diagnostic.includes('secret')) throw Error('Diagnostics did not report stages or leaked secrets');
  await page.screenshot({path:'artifacts/v03-diagnostics.png'});
  await page.getByRole('dialog').getByRole('button', {name:'关闭',exact:true}).click();
  console.log('Jump editor, separate credentials, two host fingerprints and diagnostics (mock IPC): passed.');
  // Agent starts directly and errors remain available for inspection.
  await page.getByRole('button', {name:'新建连接',exact:true}).click();
  await page.getByLabel('会话名称',{exact:true}).fill('agent-only');
  await page.getByLabel('主机地址',{exact:true}).fill('failure.example');
  await page.getByLabel('用户名',{exact:true}).fill('dev');
  await page.getByLabel('认证方式',{exact:true}).selectOption('agent');
  await page.getByRole('button',{name:'保存并连接',exact:true}).click();
  await page.getByRole('button',{name:'重新连接',exact:true}).waitFor();
  if (await page.getByRole('dialog').count()) throw Error('Agent unnecessarily asks for credentials');
  await page.getByRole('button',{name:'连接诊断',exact:true}).click();
  if (!(await page.getByLabel('连接阶段').textContent()).includes('无法连接 SSH Agent')) throw Error('Agent error missing from diagnostics');
  await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('button',{name:'编辑 agent-only',exact:true}).click();
  await page.getByLabel('主机地址',{exact:true}).fill('slow.example');
  await page.getByRole('button',{name:'保存并连接',exact:true}).click();
  await page.getByRole('button',{name:'取消连接',exact:true}).click();
  await page.getByRole('button',{name:'重新连接',exact:true}).waitFor();
  await page.getByRole('button',{name:'连接诊断',exact:true}).click();
  if (!(await page.getByLabel('连接阶段').textContent()).includes('连接已结束')) throw Error('Cancellation not reported');
  await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();
  await page.reload();
  await page.getByRole('button',{name:'编辑 internal',exact:true}).click();
  if (await page.getByLabel('跳板机主机地址',{exact:true}).inputValue() !== 'gateway.example') throw Error('Jump persistence failed');
  await page.getByRole('button',{name:'关闭对话框',exact:true}).click();
  await page.getByRole('button',{name:'导入 / 导出',exact:true}).click();
  await page.getByRole('button',{name:'导入 OpenSSH config',exact:true}).click();
  await page.getByLabel('OpenSSH 配置').fill('Host via-import\nHostName internal.example\nUser deploy\nProxyJump gateway\nHost gateway\nHostName gateway.example\nUser jumpuser');
  await page.getByRole('button',{name:'预览会话',exact:true}).click();
  await page.getByText('deploy@internal.example:22 · SSH Agent · 经 jumpuser@gateway.example:22', {exact:true}).waitFor();
  await page.getByRole('dialog').getByRole('checkbox').nth(1).uncheck();
  await page.getByRole('button',{name:'导入所选会话（1）',exact:true}).click();
  await page.getByRole('button',{name:'编辑 via-import',exact:true}).click();
  if (await page.getByLabel('跳板机认证方式',{exact:true}).inputValue() !== 'agent') throw Error('Imported jump authentication lost');
  await page.getByLabel('通过跳板机连接',{exact:true}).uncheck();
  await page.getByRole('button',{name:'仅保存',exact:true}).click();
  if (await page.evaluate(() => JSON.parse(localStorage.getItem('test-config')).sessions.find(s=>s.name==='via-import').jump)) throw Error('Jump disable failed');
  if (errors.length) throw Error(errors.join('\n'));
  console.log('Agent bypass, error diagnostics, cancellation, reload, ProxyJump import and disable: passed.');
  await page.getByRole('button', {name:'新建连接',exact:true}).click();
  await page.getByLabel('会话名称',{exact:true}).fill('otp-login');
  await page.getByLabel('主机地址',{exact:true}).fill('otp.example');
  await page.getByLabel('用户名',{exact:true}).fill('otpuser');
  await page.getByLabel('认证方式',{exact:true}).selectOption('keyboard-interactive');
  await page.getByRole('button',{name:'保存并连接',exact:true}).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByText('服务器本轮没有输入项，确认后继续认证。').waitFor();
  await dialog.getByRole('button',{name:'确认并继续',exact:true}).click();
  await dialog.getByLabel('Account:',{exact:true}).fill('otpuser');
  await dialog.getByLabel('Password:',{exact:true}).fill('ephemeral-password');
  if (await dialog.getByLabel('Account:',{exact:true}).getAttribute('type') !== 'text' || await dialog.getByLabel('Password:',{exact:true}).getAttribute('type') !== 'password') throw Error('Server echo flags lost');
  await dialog.getByLabel('显示输入内容').check();
  if (await dialog.getByLabel('Password:',{exact:true}).getAttribute('type') !== 'text') throw Error('Show input failed');
  await page.keyboard.press('Enter');
  const otp = dialog.getByLabel('[OTP Code]:',{exact:true}); await otp.waitFor();
  if (await otp.inputValue() !== '' || await otp.getAttribute('type') !== 'password' || await dialog.getByLabel('显示输入内容').isChecked()) throw Error('Challenge state not reset between rounds');
  await page.screenshot({path:'artifacts/v031-otp-dark.png'});
  await otp.fill('654321'); await page.keyboard.press('Enter');
  await page.getByText('已连接',{exact:true}).waitFor();
  const rounds = await page.evaluate(() => window.authResponses);
  if (JSON.stringify(rounds.map(r=>r.responses)) !== JSON.stringify([[],['otpuser','ephemeral-password'],['654321']])) throw Error('Wrong round answers');
  await page.getByRole('button',{name:'断开',exact:true}).click();
  await page.getByRole('button',{name:'重新连接',exact:true}).click();
  await dialog.getByText('服务器本轮没有输入项，确认后继续认证。').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'重新连接',exact:true}).waitFor();
  await page.getByRole('button',{name:'连接诊断',exact:true}).click();
  if ((await page.getByLabel('连接阶段').textContent()).match(/654321|ephemeral-password/)) throw Error('Answers leaked into diagnostics');
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  if (await page.evaluate(() => localStorage.getItem('test-config').match(/654321|ephemeral-password/))) throw Error('Answers leaked into config');
  await page.evaluate(() => {const config=JSON.parse(localStorage.getItem('test-config'));config.settings.theme='light';localStorage.setItem('test-config',JSON.stringify(config));});
  await page.reload();
  await page.getByRole('button',{name:'otp-login otp.example:22',exact:true}).click();
  await dialog.getByRole('button',{name:'确认并继续',exact:true}).click();
  await dialog.getByLabel('Password:',{exact:true}).waitFor();
  await page.screenshot({path:'artifacts/v031-otp-light.png'});
  await dialog.getByRole('button',{name:'取消连接',exact:true}).click();
  await page.getByRole('button',{name:'重新连接',exact:true}).waitFor();
  if (errors.length) throw Error(errors.join('\n'));
  console.log('OTP multi-round / zero prompts / echo / show / Enter / Escape / cancellation / secret isolation / both themes: passed (mock IPC).');
  await page.getByRole('button',{name:'编辑连接',exact:true}).click();
  await page.getByLabel('认证方式',{exact:true}).selectOption('key');
  await page.getByRole('dialog').getByText('选择私钥文件，而非 .pub 公钥。', {exact:false}).waitFor();
  await page.getByLabel('私钥文件',{exact:true}).fill('C:/test/key.pub');
  await page.getByRole('button',{name:'仅保存',exact:true}).click();
  await page.getByRole('button',{name:'重新连接',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'连接',exact:true}).click();
  await page.getByRole('button',{name:'重新连接',exact:true}).waitFor();
  if (await page.evaluate(() => window.startCalls.at(-1).session.auth) !== 'key') throw Error('Reconnect did not use newly saved key settings');
  const priorTab = await page.evaluate(() => window.startCalls.at(-1).id);
  await page.getByRole('button',{name:'编辑连接',exact:true}).click();
  await page.getByLabel('认证方式',{exact:true}).selectOption('keyboard-interactive');
  await page.screenshot({path:'artifacts/v032-auth-guidance.png'});
  await page.getByRole('button',{name:'仅保存',exact:true}).click();
  await page.getByRole('button',{name:'重新连接',exact:true}).click();
  await dialog.getByText('服务器本轮没有输入项，确认后继续认证。').waitFor();
  const resumed = await page.evaluate(() => window.startCalls.at(-1));
  if (resumed.session.auth !== 'keyboard-interactive' || resumed.id !== priorTab) throw Error('Corrected authentication not applied to the existing tab');
  await dialog.getByRole('button',{name:'取消连接',exact:true}).click();
  await page.getByRole('button',{name:'重新连接',exact:true}).waitFor();
  if (errors.length) throw Error(errors.join('\n'));
  console.log('Disconnected session edit, key guidance, saved auth correction and same-tab reconnect: passed.');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
