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
          args.channel.onmessage({ type: 'data', data: btoa(Array.from({length:200},(_,i)=>`HISTORY_LINE_${i}`).join('\r\n') + '\r\n') });
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
  for (const theme of ['dark', 'light']) {
    await page.getByRole('button',{name:'设置',exact:true}).click();
    await page.getByLabel(/^主题/).selectOption(theme);
    await page.getByRole('dialog').getByRole('button',{name:'完成',exact:true}).click();
    for (const [width,height] of [[1440,903],[1080,807],[768,707]]) {
      await page.setViewportSize({width,height});
      await page.waitForTimeout(120);
      const pane = page.locator('.terminal-pane.visible');
      const region = await pane.evaluate(p => {
        const root=p.querySelector('.xterm'), viewport=p.querySelector('.xterm-viewport'), screen=p.querySelector('.xterm-screen');
        const r=root.getBoundingClientRect(), s=screen.getBoundingClientRect();
        const background=getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
        const probe=document.createElement('div');probe.style.backgroundColor=background;document.body.appendChild(probe);
        const expected=getComputedStyle(probe).backgroundColor;probe.remove();
        if (getComputedStyle(viewport).backgroundColor!==expected || getComputedStyle(root).backgroundColor!==expected) throw Error('Row remainder background does not match theme');
        if (getComputedStyle(viewport).overflowY!=='hidden') throw Error('Legacy native scrollbar remains');
        const gap=r.bottom-s.bottom;
        if(gap < -1 || gap > 30) throw Error('Terminal has unexpected row remainder: '+gap);
        return {x:r.x+5,y:s.bottom+Math.max(0.5,gap/2),gap,expected};
      });
      const slider = pane.locator('.xterm-scrollable-element .scrollbar.vertical .slider');
      const beforeScroll = await slider.boundingBox();
      await pane.hover(); await page.mouse.wheel(0,-1200);
      await page.waitForTimeout(120);
      const afterScroll = await slider.boundingBox();
      if(!beforeScroll || !afterScroll || afterScroll.y >= beforeScroll.y - 1) throw Error('Real scrollback did not scroll upwards');
      await page.mouse.wheel(0,100000);await page.waitForTimeout(120);
      await page.screenshot({path:`artifacts/v041-terminal-${theme}-${width}.png`});
      console.log(`Theme ${theme}, ${width}x${height}: row gap ${region.gap.toFixed(2)}px matches theme; scrollback works.`);
    }
  }
  await page.setViewportSize({width:1440,height:903});
  await page.getByRole('button',{name:'复制连接',exact:true}).click();
  await page.getByRole('button',{name:'切换分屏',exact:true}).click();
  for (let i=0;i<2;i++) {
    const separator=page.getByRole('separator');await separator.focus();await page.keyboard.press('Home');
    await page.waitForTimeout(120);
    for(const viewport of await page.locator('.terminal-pane.visible .xterm-viewport').all()) {
      if(await viewport.evaluate(v=>getComputedStyle(v).overflowY)!=='hidden') throw Error('Split viewport regressed');
    }
    await page.screenshot({path:`artifacts/v041-terminal-split-${i}.png`});
    await page.getByRole('button',{name:'切换分屏',exact:true}).click();
  }
  if(errors.length) throw Error(errors.join('\n'));
  console.log('Terminal background, both themes, resize, real scrollback and split layouts: passed.');
  await browser.close();
})().catch(error=>{console.error(error);process.exit(1);});
