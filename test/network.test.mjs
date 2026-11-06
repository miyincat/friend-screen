import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as id from '../network/identity.mjs';
import {overlayCandidate,overlayDescription,verifiedPair} from '../network/media-policy.mjs';
import {Coordinator,inSubnet} from '../network/coordinator.mjs';

function fixture() {const group=id.makeGroup('0123456789abcdef','10.147.20.1'),device=id.newIdentity();device.certificate=id.issueMember(group,device);return {group,device};}
test('邀请：签名、错误群、轮换、长输入与篡改均校验',()=>{
  const {group}=fixture(),code=id.invitation(group);
  assert.equal(id.currentInvitation(code,group).groupId,group.groupId);
  assert.throws(()=>id.parseInvitation(code.slice(0,-8)+'aaaaaaaa'));
  assert.throws(()=>id.currentInvitation(code,fixture().group));
  group.invitationVersion='a'.repeat(24);assert.throws(()=>id.currentInvitation(code,group),/撤销|轮换/);
  assert.throws(()=>id.parseInvitation('FSI1.'+'a'.repeat(3000)));
});
test('成员：绑定公钥和群、拒绝伪造和撤销设备',()=>{
  const {group,device}=fixture();assert.equal(id.verifyMember(device.certificate,group).deviceId,device.deviceId);
  assert.throws(()=>id.issueMember(group,{...device,deviceId:'0'.repeat(32)}));
  assert.throws(()=>id.verifyMember(device.certificate,fixture().group));
  group.revoked.push(device.deviceId);assert.throws(()=>id.verifyMember(device.certificate,group));assert.throws(()=>id.issueMember(group,device));
});
test('连接：目标/来源绑定、重放保护和时间窗',()=>{
  const {group,device}=fixture(),address='10.147.20.2',audience='10.147.20.1:47873',nonces=new Map();
  const token=id.authorization(device,group,address,audience);
  assert.equal(id.verifyAuthorization(token,group,address,audience,nonces).deviceId,device.deviceId);
  assert.throws(()=>id.verifyAuthorization(token,group,address,audience,nonces),/重复/);
  assert.throws(()=>id.verifyAuthorization(token,group,'10.147.20.3',audience,new Map()));
  assert.throws(()=>id.verifyAuthorization(token,group,address,'10.147.20.4:47873',new Map()));
  const expired=id.signObject({certificate:device.certificate,address,audience,nonce:'a'.repeat(32),at:Date.now()-120000},device.privateKey,'friend-screen-connect-v1');
  assert.throws(()=>id.verifyAuthorization(expired,group,address,audience,new Map()));
});
test('房主握手：必须持有成员私钥并回应本次挑战',()=>{
  const {group,device}=fixture(),challenge='c'.repeat(64),proof=id.hostProof(device,'10.147.20.1',challenge);
  assert.equal(id.verifyHostProof(proof,group,'10.147.20.1',challenge).deviceId,device.deviceId);
  assert.throws(()=>id.verifyHostProof(proof,group,'10.147.20.1','d'.repeat(64)));
  assert.throws(()=>id.verifyHostProof(proof,group,'10.147.20.2',challenge));
});
test('房间号：真实寻址、随机性、校验和群隔离',()=>{
  const {group}=fixture(),code=id.roomCode(group.groupId,'10.147.20.9');
  assert.equal(code.length,61);assert.deepEqual(id.parseRoomCode(code,group.groupId),{address:'10.147.20.9',port:47873,code});
  assert.notEqual(code,id.roomCode(group.groupId,'10.147.20.9'));
  assert.throws(()=>id.parseRoomCode(code,'f'.repeat(32)));
  assert.throws(()=>id.parseRoomCode(code.slice(0,-2)+'aa',group.groupId));
  assert.throws(()=>id.roomCode(group.groupId,'8.8.8.8'));
});
test('网段：只允许所分配 RFC1918 IPv4 范围',()=>{
  assert.ok(inSubnet('10.147.20.8','10.147.20.1/24'));
  for(const address of ['10.147.21.1','127.0.0.1','8.8.8.8','::1','10.147.20.999','10.147.20.08'])assert.equal(inSubnet(address,'10.147.20.1/24'),false);
  assert.equal(inSubnet('10.147.20.8','10.147.20.1/0'),false);
});
test('媒体：丢弃 LAN、公网、mDNS、relay 和 TCP 候选；清理 SDP',()=>{
  const good='candidate:1 1 UDP 123 10.147.20.1 50000 typ host';
  assert.ok(overlayCandidate(good,'10.147.20.1'));
  for(const c of [good.replace('10.147.20.1','192.168.1.2'),good.replace('10.147.20.1','8.8.8.8'),good.replace('10.147.20.1','hidden.local'),good.replace('host','relay'),good.replace('UDP','TCP')])assert.equal(overlayCandidate(c,'10.147.20.1'),false);
  const sdp='v=0\r\nc=IN IP4 8.8.8.8\r\na='+good+'\r\na='+good.replace('10.147.20.1','8.8.8.8')+'\r\na=remote-candidates:1 8.8.8.8 9\r\n';
  const result=overlayDescription({type:'offer',sdp},'10.147.20.1');assert.ok(result.sdp.includes(good));assert.ok(!result.sdp.includes('8.8.8.8'));
});
test('媒体：实际选中路径须双端均为 overlay UDP host',()=>{
  const reports=new Map([['t',{type:'transport',selectedCandidatePairId:'p'}],['p',{type:'candidate-pair',state:'succeeded',localCandidateId:'l',remoteCandidateId:'r'}],['l',{candidateType:'host',protocol:'udp',address:'10.147.20.1'}],['r',{candidateType:'host',protocol:'udp',address:'10.147.20.2'}]]);
  assert.ok(verifiedPair(reports,'10.147.20.1','10.147.20.2'));
  reports.get('l').address='192.168.1.5';assert.equal(verifiedPair(reports,'10.147.20.1','10.147.20.2'),false);
  assert.equal(verifiedPair(new Map(),'10.147.20.1','10.147.20.2'),false);
});
test('协调器：持久身份、损坏不覆盖，入网失败不锁死首次设置',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friend-overlay-unit-'));
  // Mock storage only for unit tests; production receives Electron Windows safeStorage.
  const secureStorage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
  const options={dataDir:dir,root:process.cwd(),secureStorage};
  const a=new Coordinator(options);await a.load();const deviceId=a.state.device.deviceId;await a.close();
  const b=new Coordinator(options);await b.load();assert.equal(b.state.device.deviceId,deviceId);
  b.bridge=async()=>{throw new Error('no Windows approval');};
  await assert.rejects(b.setup({name:'测试',avatar:'',administrator:true,networkId:'0123456789abcdef'}));
  assert.equal(b.state.networkId,undefined);assert.equal(b.settingUp,false);await b.close();
  const file=path.join(dir,'device-state.bin');await writeFile(file,'damaged');
  const c=new Coordinator(options);await assert.rejects(c.load(),/损坏/);assert.equal(await readFile(file,'utf8'),'damaged');
  for(const invalid of ['null','{}',JSON.stringify({...a.state,device:{...a.state.device,privateKey:id.newIdentity().privateKey}})]) {
    await writeFile(file,invalid);const broken=new Coordinator(options);await assert.rejects(broken.load(),/损坏/);assert.equal(await readFile(file,'utf8'),invalid);
  }
  await rm(dir,{recursive:true});
});
test('协调器：退出等待正在进行的轮询，关闭后不能重启服务',async()=>{
  const c=new Coordinator({});c.state={networkId:'0123456789abcdef'};
  let release,stops=0,bridgeCalls=0,finished=false;
  const blocked=new Promise(resolve=>{release=resolve;});
  c.bridge=async(operation)=>{bridgeCalls++;if(operation==='status'){await blocked;return {address:'123456789a'};}return {status:'OK'};};
  c.stopServers=async()=>{stops++;};
  c.startServers=async()=>{assert.fail('shutdown must never start servers');};
  const polling=c.poll();assert.equal(c.poll(),polling);
  const closing=c.close().then(()=>{finished=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);
  release();await closing;assert.equal(stops,1);assert.equal(c.pollTask,null);
  const previous=bridgeCalls;await c.poll();assert.equal(bridgeCalls,previous);
});
