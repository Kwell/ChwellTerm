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
      { id: 'api', name: '开发 API', host: 'api.example', port: 22, username: 'dev', environment: 'development', auth: 'password', keyPath: '', kind: 'ssh' }
    ], snippets: [], settings: { theme: 'dark', fontSize: 13, fontFamily: 'Consolas, monospace', scrollback: 10000 } };
    if (!localStorage.getItem('workspace-test-config')) localStorage.setItem('workspace-test-config', JSON.stringify(seed));
    window.isTauri = true; window.startCalls = []; window.inputCalls = [];
    const callbacks = new Map(), terminals = new Map(); let nextId = 0;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback(fn) { callbacks.set(++nextId, fn); return nextId; }, unregisterCallback(id) { callbacks.delete(id); },
      async invoke(command, args) {
        if (command === 'load_config') return localStorage.getItem('workspace-test-config');
        if (command === 'save_config') { localStorage.setItem('workspace-test-config', args.json); return; }
        if (command === 'plugin:window|set_theme' || command === 'terminal_resize') return;
        if (command === 'start_terminal') {
          window.startCalls.push(structuredClone({ id: args.id, session: args.session, credentials: args.credentials }));
          terminals.set(args.id, args.channel);
          args.channel.onmessage({ type: 'connected' });
          args.channel.onmessage({ type: 'data', data: btoa('TRANSCRIPT_PRIVATE_MARKER\r\n') });
          return;
        }
        if (command === 'terminal_input') { window.inputCalls.push(args); return; }
        if (command === 'terminal_close') { terminals.get(args.id)?.onmessage({ type: 'closed' }); return; }
        if (command === 'list_remote') return [];
        throw Error('Unexpected mock command: ' + command);
      }
    };
  });
  await page.goto(process.env.WORKBENCH_PREVIEW_URL || 'http://127.0.0.1:1421');
  await page.getByRole('button', { name: '本地终端', exact: true }).click();
  await page.getByRole('button', { name: '开发 API api.example:22', exact: true }).click();
  await page.getByLabel('密码', { exact: true }).fill('PASSWORD_PRIVATE_MARKER');
  await page.getByRole('dialog').getByRole('button', { name: '连接', exact: true }).click();
  await page.getByText('已连接', { exact: true }).waitFor();
  await page.getByRole('button', { name: '切换分屏' }).click();
  const handle = page.getByRole('separator'); await handle.focus(); await page.keyboard.press('Home');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  if (await handle.getAttribute('aria-valuenow') !== '35') throw Error('Incorrect layout ratio');
  await page.getByRole('button', { name: '显示或隐藏文件面板' }).click();
  await page.getByRole('button', { name: '管理工作空间' }).click();
  const dialog = page.getByRole('dialog');
  await page.getByLabel('工作空间名称', { exact: true }).fill('日常开发');
  await dialog.getByRole('button', { name: '保存当前工作空间', exact: true }).click();
  await dialog.getByRole('button', { name: '打开 日常开发', exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/v040-workspace-dark.png' });
  let saved = await page.evaluate(() => JSON.parse(localStorage.getItem('workspace-test-config')));
  if (saved.workspaces.length !== 1 || saved.workspaces[0].splitRatio !== 35 || saved.workspaces[0].filesOpen !== false) throw Error('Saved layout incorrect');
  if (JSON.stringify(saved).match(/PASSWORD_PRIVATE_MARKER|TRANSCRIPT_PRIVATE_MARKER/)) throw Error('Workspace contains secrets or terminal data');
  const savedActive = saved.workspaces[0].tabs.find(t => t.id === saved.workspaces[0].activeTabId);
  if (savedActive.sessionId !== 'api') throw Error('Active tab not saved');
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('启动时恢复上次工作空间').check();
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await page.reload();
  await page.getByRole('tab', { name: '开发 API', exact: true }).waitFor();
  if (await page.evaluate(() => window.startCalls.length) !== 0) throw Error('Startup restoration auto-connected');
  if (await page.getByRole('tab').count() !== 2 || await handle.getAttribute('aria-valuenow') !== '35') throw Error('Startup tabs or split ratio lost');
  if (!await page.locator('.workspace').evaluate(el => el.classList.contains('files-hidden'))) throw Error('Files panel state lost');
  if (await page.getByRole('tab', { name: '开发 API', exact: true }).getAttribute('aria-selected') !== 'true') throw Error('Startup active tab lost');
  await page.screenshot({ path: 'artifacts/v040-workspace-restored.png' });
  console.log('Old config migration, named save, startup restore, layout and secret isolation: passed.');

  await page.getByRole('button', { name: '管理工作空间' }).click();
  await dialog.getByRole('button', { name: '打开 日常开发', exact: true }).click();
  if (await page.getByRole('tab').count() !== 4 || await page.evaluate(() => window.startCalls.length) !== 0) throw Error('Opening a workspace changed existing terminals or auto-connected');
  if (await page.locator('.terminal-pane.visible .restored-terminal').count() !== 2) throw Error('Saved second panel was not restored');
  await page.getByRole('button', { name: '连接 开发 API', exact: true }).click();
  await page.getByLabel('密码', { exact: true }).waitFor();
  if (await page.getByLabel('密码', { exact: true }).inputValue() !== '') throw Error('Restored credentials reused');
  await page.getByLabel('密码', { exact: true }).fill('REAUTH_PRIVATE_MARKER');
  await dialog.getByRole('button', { name: '连接', exact: true }).click();
  await page.getByText('已连接', { exact: true }).waitFor();
  await page.getByRole('button', { name: '复制连接', exact: true }).click();
  if (await page.getByLabel('密码', { exact: true }).inputValue() !== '') throw Error('Duplicate connection reused credentials');
  await page.getByLabel('密码', { exact: true }).fill('DUPLICATE_PRIVATE_MARKER');
  await dialog.getByRole('button', { name: '连接', exact: true }).click();
  await page.getByText('已连接', { exact: true }).waitFor();
  const started = await page.evaluate(() => window.startCalls);
  if (started.length !== 2 || started[0].id === started[1].id || started[0].session.id !== started[1].session.id) throw Error('Duplicate did not create an independent connection');
  await page.getByRole('button', { name: '管理工作空间' }).click();
  await dialog.getByRole('button', { name: '更新为当前布局', exact: true }).click();
  await dialog.getByRole('button', { name: '确认更新布局', exact: true }).click();
  await dialog.getByRole('button', { name: '重命名工作空间 日常开发', exact: true }).click();
  await page.getByLabel('新的工作空间名称').fill('运维工作台');
  await dialog.getByRole('button', { name: '保存名称', exact: true }).click();
  await dialog.getByRole('button', { name: '打开 运维工作台', exact: true }).waitFor();
  saved = await page.evaluate(() => JSON.parse(localStorage.getItem('workspace-test-config')));
  if (saved.workspaces[0].tabs.length !== 5) throw Error('Workspace layout update lost repeated sessions');
  if (JSON.stringify(saved).match(/REAUTH_PRIVATE_MARKER|DUPLICATE_PRIVATE_MARKER|TRANSCRIPT_PRIVATE_MARKER/)) throw Error('Credentials or transcript persisted');
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.reload(); await page.getByRole('tab').first().waitFor();
  if (await page.getByRole('tab').count() !== 5 || await page.evaluate(() => window.startCalls.length) !== 0) throw Error('Duplicate session tabs did not survive restart');
  console.log('Append restoration, saved second panel, manual reauth, independent duplicate, layout update and rename: passed.');

  await page.evaluate(() => {
    const config = JSON.parse(localStorage.getItem('workspace-test-config'));
    config.sessions = config.sessions.filter(s => s.id !== 'api'); config.settings.theme = 'light';
    localStorage.setItem('workspace-test-config', JSON.stringify(config));
  });
  await page.reload(); await page.getByRole('tab', { name: '本地终端', exact: true }).first().waitFor();
  if (await page.getByRole('tab').count() !== 2 || await handle.count() !== 1 || await page.evaluate(() => window.startCalls.length) !== 0) throw Error('Deleted sessions not skipped');
  await page.getByRole('button', { name: '管理工作空间' }).click();
  await dialog.getByText(/3 个会话已删除，打开时跳过/).waitFor();
  await page.screenshot({ path: 'artifacts/v040-workspace-light.png' });
  await dialog.getByRole('button', { name: '删除工作空间 运维工作台', exact: true }).click();
  await dialog.getByRole('button', { name: '取消删除', exact: true }).click();
  await dialog.getByRole('button', { name: '打开 运维工作台', exact: true }).waitFor();
  await dialog.getByRole('button', { name: '删除工作空间 运维工作台', exact: true }).click();
  await dialog.getByRole('button', { name: '确认删除工作空间', exact: true }).click();
  if ((await page.evaluate(() => JSON.parse(localStorage.getItem('workspace-test-config')))).workspaces.length) throw Error('Delete not persisted');
  if (await page.getByRole('tab').count() !== 2) throw Error('Deleting layout closed terminals');
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('启动时恢复上次工作空间').uncheck();
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await page.reload(); await page.getByRole('button', { name: '新建 SSH 连接', exact: true }).waitFor();
  if (await page.getByRole('tab').count() !== 0) throw Error('Startup restoration preference ignored');
  if (errors.length) throw Error(errors.join('\n'));
  console.log('Missing sessions, both themes, delete/cancel without closing tabs, disabled startup restore and runtime errors: passed.');
  await browser.close();
})().catch(error => { console.error(error); process.exit(1); });
