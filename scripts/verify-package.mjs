import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),asar=require('@electron/asar');
const {validManifest,artifactHash}=require('../desktop/update-manifest.cjs');
const root=process.cwd(),version=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version,release=path.join(root,'dist',version),unpacked=path.join(release,'win-unpacked'),archive=path.join(unpacked,'resources','app.asar');
const sha=b=>createHash('sha256').update(b).digest('hex');
const paths=asar.listPackage(archive).map(v=>v.replaceAll(String.fromCharCode(92),'/').replace(/^\//,''));
assert.equal(JSON.parse(asar.extractFile(archive,'package.json').toString()).version,version);
assert.ok(paths.includes('node_modules/ws/LICENSE'));assert.ok(paths.includes('node_modules/fflate/LICENSE'));
assert.ok(paths.includes('node_modules/electron-updater/package.json'));
assert.ok(!paths.some(v=>!v.startsWith('node_modules/')&&/(^|\/)(artifacts|test|vendor|dist|data)(\/|$)/.test(v)));
assert.ok(!paths.some(v=>/device-state|zerotier-auth|connection\.json|update-signing-key|(^|\/)\.env($|\/)/.test(v)));
const files=[];
for(const name of ['network/coordinator.mjs','network/identity.mjs','network/media-policy.mjs','network/piik-client.mjs','network/media-tree.mjs','public/piik-media.js','public/media-controls.js','public/source-picker.js','public/share-settings.js','public/share-settings.css','public/share-art-gold.jpg','public/share-art-teal.jpg','public/share-art-sakura.jpg','server.mjs','desktop/main.cjs','desktop/media-runtime.cjs','desktop/diagnostics.cjs','desktop/diagnostics-recorder.cjs','desktop/diagnostics.html','desktop/diagnostics.js','desktop/diagnostics.css','public/diagnostic-telemetry.js','desktop/preload.cjs','desktop/launcher.html','desktop/launcher.js','public/app.js','public/index.html','public/styles.css','public/device-profile.js','public/pending-signals.js']){
  const original=await readFile(path.join(root,name)),packaged=asar.extractFile(archive,name);assert.equal(sha(packaged),sha(original),name);files.push({file:'app.asar/'+name,sha256:sha(packaged),sourceMatches:true});
}
for(const [from,to] of [
 ['native/bin/OverlayBridge.exe','native/OverlayBridge.exe'],
 ...['LICENSE','THIRD-PARTY-NOTICES.txt','FRIENDSCREEN-MODIFICATIONS.txt','BUILD.json','piik-app.exe','runtime/native/piik-capture.exe'].map(v=>['vendor/piik/'+v,'piik/'+v]),
 ['vendor/piik-source/LICENSE','licenses/Piik-MIT.txt'],
 ['vendor/zerotier/ZeroTierOne-1.14.2.msi','network-component/ZeroTierOne-1.14.2.msi'],
 ['vendor/zerotier/ZeroTierOne-1.14.2-source.tar.gz','network-component/ZeroTierOne-1.14.2-source.tar.gz'],
 ['vendor/zerotier/ZeroTier-DesktopUI-1.8.4-source.tar.gz','network-component/ZeroTier-DesktopUI-1.8.4-source.tar.gz'],
 ...['friends-guide.md','administrator-guide.md','diagnostics-guide.md',`release-${version}.md`,`test-report-${version}.md`].map(v=>['docs/'+v,'docs/'+v]),
 ...['Apache-2.0.txt','GPL-2.0.txt','THIRD-PARTY-NOTICES.txt','ZeroTier-1.14.2-BSL-change-notice.txt','ZeroTier-COPYING.txt','ZeroTier-DesktopUI-LICENSE.txt'].map(v=>['licenses/'+v,'licenses/'+v]),
 ['scripts/install-overlay.ps1','install-overlay.ps1'],['scripts/uninstall-overlay.ps1','uninstall-overlay.ps1']
]){const original=await readFile(path.join(root,from)),packaged=await readFile(path.join(unpacked,'resources',to));assert.equal(sha(packaged),sha(original),to);files.push({file:'resources/'+to,bytes:packaged.length,sha256:sha(packaged),sourceMatches:true});}
await assert.rejects(stat(path.join(unpacked,'resources/piik/runtime/tunnel/cloudflared.exe')));
assert.ok(!(await readFile(path.join(unpacked,'resources/piik/piik-app.exe'))).includes(Buffer.from('FRIEND_SYNTHETIC_RTP_TRACE')),'release must not contain the temporary packet trace');
const installer=path.join(release,`FriendScreen-${version}-Setup-x64.exe`),binary=await readFile(installer);
assert.ok((await stat(installer)).size>1e8);
const updateResources=path.join(unpacked,'resources');
const channel=JSON.parse(await readFile(path.join(updateResources,'friend-screen-update.json'),'utf8'));
const manifest=JSON.parse(await readFile(path.join(release,'latest.yml'),'utf8'));
assert.ok(validManifest(manifest,channel.publicKey));
assert.equal(manifest.sha512,await artifactHash(installer));
assert.equal(manifest.files[0].size,binary.length);
assert.ok((await stat(installer+'.blockmap')).size>0);
assert.ok((await stat(path.join(updateResources,'elevate.exe'))).size>0);
for(const name of ['desktop/updates.cjs','desktop/update-manifest.cjs','desktop/updates.html','desktop/updates-renderer.js','desktop/updates.css']){
  const original=await readFile(path.join(root,name)),packaged=asar.extractFile(archive,name);
  assert.equal(sha(packaged),sha(original),name);
  files.push({file:'app.asar/'+name,sha256:sha(packaged),sourceMatches:true});
}
const result={version,date:new Date().toISOString(),passed:true,installer:{path:installer,bytes:binary.length,sha256:sha(binary)},archiveEntries:paths.length,containsProductionUserData:false,files,limits:'Static package consistency and unpacked application startup only. Clean installation, UAC, ZeroTier enrollment and cross-network media remain unverified.'};
await writeFile(path.join(release,'package-verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,matchedFiles:files.length,installer:result.installer},null,2));
