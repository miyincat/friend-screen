import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {Zip,ZipDeflate,unzipSync} from 'fflate';
import assert from 'node:assert/strict';

const root=process.cwd(),version=JSON.parse(await fs.readFile('package.json','utf8')).version;
const release=path.join(root,'dist',version),destination=path.resolve(root,'..',`同屏小屋-${version}`);
const sha=b=>createHash('sha256').update(b).digest('hex');
const roots=['desktop','public','network','native','scripts','build','docs','licenses','vendor','test'];
const names=['package.json','package-lock.json','electron-builder.json','README.md','server.mjs','accounts.mjs','start-local.cmd','.env.example','.gitignore'];
async function walk(folder){for(const entry of await fs.readdir(path.join(root,folder),{withFileTypes:true})){
  const file=folder+'/'+entry.name;
  if(['node_modules','.git','__pycache__'].includes(entry.name)||file==='vendor/piik-source/build')continue;
  assert.ok(!entry.isSymbolicLink(),file);
  if(entry.isDirectory())await walk(file);else if(entry.isFile())names.push(file);
}}
for(const folder of roots)await walk(folder);names.sort();
for(const file of names)assert.ok(!/\.(pem|key|dpapi|log)$|(^|\/)(device-state\.bin|connection\.json|authtoken\.secret|\.env)$/.test(file),file);
await fs.mkdir(destination,{recursive:true});
const source=path.join(release,`FriendScreen-${version}-source.zip`),stream=createWriteStream(source),sourceManifest=[];
const finished=new Promise((resolve,reject)=>{stream.on('finish',resolve);stream.on('error',reject);});
const archive=new Zip((error,chunk,final)=>{if(error)stream.destroy(error);else{stream.write(chunk);if(final)stream.end();}});
for(const file of names){const bytes=await fs.readFile(path.join(root,file));sourceManifest.push({path:file,bytes:bytes.length,sha256:sha(bytes)});const entry=new ZipDeflate('friend-screen/'+file,{level:6});archive.add(entry);entry.push(bytes,true);}
archive.end();await finished;
const unpacked=unzipSync(await fs.readFile(source));assert.equal(Object.keys(unpacked).length,sourceManifest.length);
for(const item of sourceManifest)assert.equal(sha(unpacked['friend-screen/'+item.path]),item.sha256,item.path);
await fs.writeFile(path.join(release,'source-manifest.json'),JSON.stringify(sourceManifest,null,2));
const packaged=JSON.parse(await fs.readFile(path.join(release,'package-verification.json'),'utf8'));
assert.equal(sha(await fs.readFile(path.join(release,`FriendScreen-${version}-Setup-x64.exe`))),packaged.installer.sha256);
const files=[];
for(const name of [`FriendScreen-${version}-Setup-x64.exe`,path.basename(source),'source-manifest.json','package-verification.json']){
  const from=path.join(release,name),to=path.join(destination,name);await fs.copyFile(from,to);const bytes=await fs.readFile(to);assert.equal(sha(bytes),sha(await fs.readFile(from)));files.push({path:to,bytes:bytes.length,sha256:sha(bytes)});
}
for(const name of ['friends-guide.md','administrator-guide.md','diagnostics-guide.md',`release-${version}.md`,`test-report-${version}.md`])await fs.copyFile(path.join(root,'docs',name),path.join(destination,name));
for(const [folder,names] of Object.entries({[`private-native-${version}`]:['results.json','01-relayed-view.png'],[`smooth-viewing-${version}`]:['results.json','smooth-view.png'],[`private-packaged-${version}`]:['results.json','packaged-fixture.png']})){
  const target=path.join(destination,'测试证据',folder);await fs.mkdir(target,{recursive:true});
  for(const name of names)await fs.copyFile(path.join(root,'artifacts',folder,name),path.join(target,name));
}
const manifest={version,date:new Date().toISOString(),sourceRoot:root,sourceFileCount:names.length,outputDirectory:destination,files,verification:{package:'package-verification.json',native:`测试证据/private-native-${version}/results.json`,smoothPlayback:`测试证据/smooth-viewing-${version}/results.json`,packaged:`测试证据/private-packaged-${version}/results.json`,crossNetworkMedia:'未验证',cleanInstallationAndIdentityMigration:'未验证'},notes:'未签名 Windows 私网测试版。受控本机测试使用合成窗口/声音，不代表真实校园网或游戏负载。源代码和包中不含生产身份、长期凭证或音视频内容。'};
for(const folder of [release,destination])await fs.writeFile(path.join(folder,'delivery-manifest.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({version,sourceFileCount:names.length,outputDirectory:destination,files},null,2));
