import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),output=process.env.DESKTOP_ARTIFACTS_DIR?path.resolve(process.env.DESKTOP_ARTIFACTS_DIR):path.join(root,'artifacts','overlay-tests');await mkdir(output,{recursive:true});
const data=await mkdtemp(path.join(output,'desktop-profile-'));
let app;const checks=[],errors=[];
const pass=name=>{checks.push(name);console.log('PASS '+name);};
async function launch(){app=await electron.launch({...(process.env.DESKTOP_EXE?{executablePath:process.env.DESKTOP_EXE,args:[]}:{args:['.']}),cwd:root,env:{...process.env,FRIEND_SCREEN_LEGACY_TEST:'',FRIEND_SCREEN_SKIP_AUTO_CONNECT:'1',FRIEND_SCREEN_USER_DATA:data},timeout:30000});const page=await app.firstWindow();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>document.querySelector('#device-id').textContent!=='正在读取');return page;}
try {
  let page=await launch();
  const device=await page.locator('#device-id').textContent();assert.match(device,/^[a-f0-9]{12}$/);
  assert.equal(await page.locator('#legacy-tests').isVisible(),false);
  assert.equal(await page.locator('#enter-btn').isDisabled(),true);
  await page.screenshot({path:path.join(output,'first-start.png')});pass('首次启动显示昵称、头像、邀请码，开发入口不可见');
  await page.locator('#nickname').fill('测试朋友');await page.locator('#invitation').fill('错误邀请码');await page.locator('#setup-btn').click();
  await page.waitForFunction(()=>document.querySelector('#launcher-status').classList.contains('error'));
  assert.match(await page.locator('#launcher-status').textContent(),/邀请码/);pass('错误邀请码明确拒绝，没有申请网络或启动媒体');
  const prefs=await app.evaluate(({BrowserWindow})=>{const p=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return {node:p.nodeIntegration,sandbox:p.sandbox,isolation:p.contextIsolation};});
  assert.deepEqual(prefs,{node:false,sandbox:true,isolation:true});
  await app.close();app=null;
  const stored=await readFile(path.join(data,'device-state.bin'));
  assert.ok(!stored.toString().includes('PRIVATE KEY'));assert.ok(!stored.toString().includes('deviceId'));pass('真实 Windows safeStorage 密文保存身份，无明文私钥');
  page=await launch();assert.equal(await page.locator('#device-id').textContent(),device);pass('重启后设备 ID 保持不变');
  await page.locator('#administrator-settings summary').click();await page.locator('#administrator').check();await page.locator('#network-id').fill('bad');await page.locator('#nickname').fill('管理员测试');await page.locator('#setup-btn').click();
  await page.waitForFunction(()=>document.querySelector('#launcher-status').classList.contains('error'));assert.match(await page.locator('#launcher-status').textContent(),/16 位/);pass('管理员 Network ID 格式校验');
  assert.deepEqual(errors,[]);await writeFile(path.join(output,process.env.DESKTOP_EXE?'packaged-desktop-results.json':'desktop-results.json'),JSON.stringify({date:new Date().toISOString(),checks,errors,dataDir:data,limits:'No UAC, actual enrollment, adapter, cross-network or clean Windows install tested.'},null,2));
}finally{await app?.close();}
