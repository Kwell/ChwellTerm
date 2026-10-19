const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
fs.mkdirSync('artifacts', { recursive: true });

(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const seed = { version: 1, sessions: [
      { id: 'local', name: '终端 1', host: '', port: 22, username: '', environment: 'personal', auth: 'key', keyPath: '', kind: 'local' },
      { id: 'api', name: '开发 API', host: 'api.example', port: 22, username: 'dev', environment: 'development', auth: 'password', keyPath: '', kind: 'ssh' }
    ], snippets: [], settings: { theme: 'dark', fontSize: 13, fontFamily: 'Consolas, monospace', scrollback: 10000 } };
    seed.sessions = Array.from({length:5},(_,i)=>({...seed.sessions[0],id:'local-'+i,name:'终端 '+(i+1)}));
    if (!localStorage.getItem('workspace-test-config')) localStorage.setItem('workspace-test-config', JSON.stringify(seed));
    window.isTauri = true; window.startCalls = []; window.inputCalls = []; window.resizeCalls = [];
    const callbacks = new Map(), terminals = new Map(); let nextId = 0;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback(fn) { callbacks.set(++nextId, fn); return nextId; }, unregisterCallback(id) { callbacks.delete(id); },
      async invoke(command, args) {
        if (command === 'load_config') return localStorage.getItem('workspace-test-config');
        if (command === 'save_config') { localStorage.setItem('workspace-test-config', args.json); return; }
        if (command === 'plugin:window|set_theme') return;
        if (command === 'terminal_resize') { window.resizeCalls.push(args); return; }
        if (command === 'start_terminal') {
          window.startCalls.push(structuredClone({ id: args.id, session: args.session, credentials: args.credentials }));
          terminals.set(args.id, args.channel);
          args.channel.onmessage({ type: 'connected' });
          args.channel.onmessage({ type: 'data', data: btoa('SHELL_'+args.id+'\r\n') });
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
  const gridButton=page.getByRole('button',{name:'四宫格布局',exact:true});
  await gridButton.click(); await page.getByRole('status').filter({hasText:'至少两个终端'}).waitFor();
  for(let i=1;i<=3;i++) await page.locator('.session-open').filter({hasText:`终端 ${i}`}).click();
  await gridButton.click(); await page.locator('.terminals.grid').waitFor();
  const visible=page.locator('.terminal-pane.visible');
  if(await visible.count()!==3 || await page.locator('.grid-empty').count()!==1) throw Error('Three terminals must show and leave one empty panel');
  await page.screenshot({path:'artifacts/v060-grid-three.png'});
  await page.getByRole('button',{name:'复制当前连接',exact:true}).click();
  if(await visible.count()!==4) throw Error('Empty pane did not open a fourth independent connection');
  await page.locator('.session-open').filter({hasText:'终端 5'}).click();
  await page.waitForTimeout(150);
  if(await visible.count()!==4 || await page.getByRole('tab').count()!==5) throw Error('Fifth tab should replace the active panel without closing tabs');
  const ids=await page.evaluate(()=>window.startCalls.map(call=>call.id));
  const panelIds=()=>visible.evaluateAll(panes=>panes.map(p=>({id:p.dataset.tabId,column:p.style.gridColumn,row:p.style.gridRow,order:p.style.order})).sort((a,b)=>Number(a.order)-Number(b.order)));
  let positions=await panelIds();
  if(!positions.some(p=>p.id===ids[4])) throw Error('New tab not displayed');
  const focusId=positions[1].id;
  const focusPane=page.locator(`[data-tab-id="${focusId}"]`);
  await focusPane.locator('.xterm-screen').click({position:{x:30,y:30}}); await page.keyboard.type('FOCUSED_INPUT');
  const afterFocus=await panelIds();
  if(JSON.stringify(afterFocus)!==JSON.stringify(positions)) throw Error('Focus moved grid panels');
  await page.waitForTimeout(80);
  if((await page.evaluate(()=>window.inputCalls)).filter(c=>c.data).some(call=>call.id!==focusId)) throw Error('Input sent to wrong panel');
  const hiddenId=ids.find(id=>!positions.some(p=>p.id===id));
  await page.getByRole('tab').nth(ids.indexOf(hiddenId)).click();
  const afterHidden=await panelIds();
  const focusIndex=positions.findIndex(p=>p.id===focusId);
  if(afterHidden[focusIndex].id!==hiddenId || afterHidden.some((p,i)=>i!==focusIndex && p.id!==positions[i].id)) throw Error('Hidden tab did not replace only the focused panel');
  await page.getByLabel('面板 1 的终端',{exact:true}).selectOption(afterHidden[3].id);
  const swapped=await panelIds();
  if(swapped[0].id!==afterHidden[3].id || swapped[3].id!==afterHidden[0].id || new Set(swapped.map(p=>p.id)).size!==4) throw Error('Panel selection did not swap visible tabs');
  const columns=page.getByRole('separator',{name:'调整四宫格左右比例',exact:true}), rows=page.getByRole('separator',{name:'调整四宫格上下比例',exact:true});
  await page.waitForTimeout(100);
  await columns.focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
  await rows.focus(); await page.keyboard.press('End'); await page.keyboard.press('ArrowUp');
  if(await columns.getAttribute('aria-valuenow')!=='25' || await rows.getAttribute('aria-valuenow')!=='75') throw Error(`Grid ratio keyboard controls failed: ${await columns.getAttribute('aria-valuenow')} / ${await rows.getAttribute('aria-valuenow')}`);
  const area=await page.locator('.terminals.grid').boundingBox(), handle=await columns.boundingBox();
  await page.mouse.move(handle.x+3,handle.y+25); await page.mouse.down(); await page.mouse.move(area.x+area.width*.4,area.y+25); await page.mouse.up();
  if(await columns.getAttribute('aria-valuenow')!=='40') throw Error('Grid horizontal drag failed');
  const rowHandle=await rows.boundingBox();
  await page.mouse.move(rowHandle.x+20,rowHandle.y+3); await page.mouse.down(); await page.mouse.move(area.x+20,area.y+area.height*.6); await page.mouse.up();
  if(await rows.getAttribute('aria-valuenow')!=='60') throw Error('Grid vertical drag failed');
  await page.waitForTimeout(180);
  for(const pane of await visible.all()) {
    const metrics=await pane.locator('.xterm-screen').boundingBox();
    if(!metrics || metrics.height<30 || metrics.width<80) throw Error('Grid terminal has invalid fit');
  }
  for(const id of (await panelIds()).map(p=>p.id)) if(!(await page.evaluate(()=>window.resizeCalls)).some(call=>call.id===id && call.cols>0 && call.rows>0)) throw Error('Missing PTY resize for '+id);
  await page.screenshot({path:'artifacts/v060-grid-dark.png'});
  if((await page.evaluate(()=>window.startCalls)).length!==5) throw Error('Layout or focus reconnected a terminal');
  await page.getByRole('button',{name:'管理工作空间',exact:true}).click();
  const dialog=page.getByRole('dialog'); await page.getByLabel('工作空间名称',{exact:true}).fill('多终端');
  await dialog.getByRole('button',{name:'保存当前工作空间',exact:true}).click();
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('workspace-test-config')).workspaces[0]);
  if(saved.layout!=='grid' || saved.paneTabIds.join(',')!==(await panelIds()).map(p=>p.id).join(',') || saved.splitRatio!==40 || saved.rowRatio!==60) throw Error('Grid workspace not captured exactly');
  await dialog.getByRole('button',{name:'关闭对话框',exact:true}).click();
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByLabel('启动时恢复上次工作空间').check(); await page.getByLabel(/^主题/).selectOption('light');
  await dialog.getByRole('button',{name:'完成',exact:true}).click();
  await page.screenshot({path:'artifacts/v060-grid-light.png'});
  await page.reload(); await page.locator('.terminals.grid').waitFor();
  if((await page.evaluate(()=>window.startCalls)).length!==0 || await visible.count()!==4) throw Error('Startup should restore grid without authentication');
  const restored=await panelIds(), restoredTabIds=await page.locator('.terminal-pane').evaluateAll(panes=>panes.map(p=>p.dataset.tabId));
  if(restored.map(p=>restoredTabIds.indexOf(p.id)).join(',')!==saved.paneTabIds.map(id=>saved.tabs.findIndex(tab=>tab.id===id)).join(',')) throw Error('Grid positions not restored');
  if(await columns.getAttribute('aria-valuenow')!=='40' || await rows.getAttribute('aria-valuenow')!=='60') throw Error('Ratios not restored');
  await page.screenshot({path:'artifacts/v060-grid-restored.png'});
  await page.setViewportSize({width:600,height:707}); await page.waitForTimeout(150);
  if(await columns.isVisible() || await rows.isVisible()) throw Error('Narrow grid handles should hide');
  const narrow=await panelIds();
  const ordered=await visible.evaluateAll(panes=>panes.map(p=>({id:p.dataset.tabId,y:p.getBoundingClientRect().top})).sort((a,b)=>a.y-b.y));
  if(ordered.map(p=>p.id).join(',')!==narrow.map(p=>p.id).join(',')) throw Error('Narrow layout lost panel order');
  const firstOverlay=visible.locator('.restored-terminal').first();
  const overlayBox=await firstOverlay.boundingBox(), connectBox=await firstOverlay.getByRole('button').boundingBox();
  if(!overlayBox || !connectBox || connectBox.y+connectBox.height>overlayBox.y+overlayBox.height) throw Error('Narrow restored connection button is clipped');
  await page.screenshot({path:'artifacts/v060-grid-narrow.png'});
  await page.setViewportSize({width:1440,height:900}); await page.waitForTimeout(150);
  await rows.dblclick(); if(await rows.getAttribute('aria-valuenow')!=='50') throw Error('Ratio reset failed');
  await page.getByRole('button',{name:'管理工作空间',exact:true}).click();
  await dialog.getByRole('button',{name:'打开 多终端',exact:true}).click();
  if(await page.getByRole('tab').count()!==10 || await visible.count()!==4 || (await page.evaluate(()=>window.startCalls)).length!==0) throw Error('Opening grid workspace did not append disconnected tabs');
  const appended=await panelIds();
  await page.locator(`[data-tab-id="${appended[0].id}"]`).getByRole('button',{name:/^连接 /}).click();
  await page.getByText('已连接',{exact:true}).waitFor();
  if((await page.evaluate(()=>window.startCalls)).length!==1) throw Error('Manual connection started unrelated tabs');
  await gridButton.click(); if(await visible.count()!==1) throw Error('Grid cannot return to single terminal');
  await gridButton.click(); if(await visible.count()!==4) throw Error('Grid cannot reopen');
  if((await page.evaluate(()=>window.startCalls)).length!==1) throw Error('Layout toggle reconnected terminal');
  // Close all ten restored tabs; grid must shrink without orphan panels.
  while(await page.getByRole('tab').count()) await page.locator('.tab').first().locator('button').last().click();
  if(await page.locator('.terminals.grid').count() || await visible.count()) throw Error('Closing tabs left a grid or visible terminal');
  if(errors.length) throw Error(errors.join('\n'));
  console.log('Grid: three/four panes, independent copy, fifth tab, stable focus/input, slot swap, both drag/keyboard ratios, PTY resize, no reconnect, workspace/append/startup restoration, narrow order, manual auth and close cleanup passed (mock IPC).');
  await browser.close();
})().catch(error=>{console.error(error);process.exit(1);});
