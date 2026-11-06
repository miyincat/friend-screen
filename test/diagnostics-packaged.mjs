import {_electron as electron} from '@playwright/test';
import {mkdir,mkdtemp,readFile,writeFile,stat,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {unzipSync,strFromU8} from 'fflate';
const root=process.cwd(),out=path.join(root,'artifacts/diagnostics-packaged-0.3.9');await mkdir(out,{recursive:true});
const data=await mkdtemp(path.join(out,'fresh-profile-')),result={date:new Date().toISOString(),checks:[],errors:[],limits:'Packaged EXE, fresh synthetic local identity, actual Windows desktop output. No actual installer run, prior-identity migration or remote network media.'};
let app,desktop,previousLatest,latestPath,generated;
try{
  app=await electron.launch({executablePath:path.join(root,'dist/0.3.9/win-unpacked/FriendScreen.exe'),args:[],cwd:root,env:{...process.env,FRIEND_SCREEN_USER_DATA:data,FRIEND_SCREEN_SKIP_AUTO_CONNECT:'1'},timeout:30000});
  assert.equal(await app.evaluate(()=>process.versions.electron),'45.2.2');
  assert.equal(await app.evaluate(({app})=>app.commandLine.getSwitchValue('force-fieldtrials')),'WebRTC-Video-H26xPacketBuffer/Enabled/');
  const main=await app.firstWindow();await main.waitForFunction(()=>window.desktopLauncher&&document.querySelector('#device-id')?.textContent!=='正在读取');
  const next=app.waitForEvent('window');await app.evaluate(({Menu})=>Menu.getApplicationMenu().getMenuItemById('diagnostics-window').click());
  const panel=await next;panel.on('pageerror',e=>result.errors.push(e.message));await panel.locator('#record-toggle').waitFor();assert.equal((await panel.evaluate(()=>window.desktopDiagnostics.action('state'))).active,false);
  desktop=await app.evaluate(({app})=>app.getPath('desktop'));latestPath=path.join(desktop,'同屏小屋诊断','latest.json');previousLatest=await readFile(latestPath).catch(()=>null);
  result.checks.push('打包程序菜单打开独立诊断窗口，默认关闭');
  await panel.locator('#record-toggle').click();await panel.waitForFunction(()=>document.querySelector('#record-toggle').getAttribute('aria-pressed')==='true');await panel.waitForTimeout(6500);
  await panel.locator('#mark-kind').selectOption('no-audio');await panel.locator('#mark').click();await panel.screenshot({path:path.join(out,'window.png')});
  await panel.locator('#record-toggle').click();await panel.waitForFunction(()=>document.querySelector('#record-info').textContent.includes('.zip'),{},{timeout:15000});
  const state=await panel.evaluate(()=>window.desktopDiagnostics.action('state'));generated={folder:state.folder,zip:state.zip};
  assert.equal(path.dirname(state.zip),desktop);const bytes=await readFile(state.zip),files=unzipSync(bytes),summary=JSON.parse(strFromU8(files['summary.json']));
  assert.ok(summary.samples>=2);assert.equal(summary.eventCounts.mark,1);assert.equal(summary.version,'0.3.9');
  const samples=strFromU8(files['samples.jsonl']).trim().split('\n').map(JSON.parse);assert.ok(samples.some(s=>Number.isFinite(s.host.resources.electronCpuPercent)));assert.ok(samples.some(s=>Number.isFinite(s.host.resources.systemCpuPercent)));
  assert.ok(!Object.values(files).map(strFromU8).join('').includes(data));
  result.checks.push('实际桌面 ZIP 保存成功，包内 fflate 可正常压缩解压');result.checks.push('采样、系统与程序资源、问题标记和摘要内容正确');
  result.exampleZip={path:state.zip,bytes:bytes.length};result.summary=summary;assert.deepEqual(result.errors,[]);result.passed=true;
}catch(e){result.passed=false;result.errors.push(e.message);process.exitCode=1;}
finally{
  await app?.close().catch(()=>{});
  // Only relocate this synthetic run. Preserve the user's previous latest
  // pointer, unless another real run has replaced it in the meantime.
  if(generated){
    assert.equal(path.dirname(generated.zip),desktop);assert.equal(path.dirname(generated.folder),path.join(desktop,'同屏小屋诊断'));
    const evidence=path.join(data,'desktop-export');await mkdir(evidence);
    const savedZip=path.join(evidence,path.basename(generated.zip));await rename(generated.zip,savedZip);await rename(generated.folder,path.join(evidence,path.basename(generated.folder)));
    const current=await readFile(latestPath).then(b=>JSON.parse(b)).catch(()=>null);
    if(current?.name===path.basename(generated.folder)){if(previousLatest)await writeFile(latestPath,previousLatest);else await rm(latestPath);}
    result.exampleZip={...result.exampleZip,originalDesktopPath:generated.zip,path:savedZip,note:'Synthetic self-test relocated to evidence; do not use as a real incident log.'};
  }
  await writeFile(path.join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
