import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { createApp, readConfig } from '../server.mjs';
import { validAvatar } from '../accounts.mjs';
import * as identity from './identity.mjs';

const execute = promisify(execFile);
const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/index.html', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/piik-media.js', ['piik-media.js', 'text/javascript']],
  ['/diagnostic-telemetry.js', ['diagnostic-telemetry.js', 'text/javascript']],
  ['/media-controls.js', ['media-controls.js', 'text/javascript']],
  ['/share-settings.js', ['share-settings.js', 'text/javascript']],
  ['/source-picker.js', ['source-picker.js', 'text/javascript']],
  ['/share-settings.css', ['share-settings.css', 'text/css']],
  ['/share-art-gold.jpg', ['share-art-gold.jpg', 'image/jpeg']],
  ['/share-art-teal.jpg', ['share-art-teal.jpg', 'image/jpeg']],
  ['/share-art-sakura.jpg', ['share-art-sakura.jpg', 'image/jpeg']],
  ['/pending-signals.js', ['pending-signals.js', 'text/javascript']],
  ['/profile.js', ['device-profile.js', 'text/javascript']],
  ['/styles.css', ['styles.css', 'text/css']],
  ['/media-policy.js', ['../network/media-policy.mjs', 'text/javascript']],
]);
function profile(value) {
  if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 24 || /[\x00-\x1f\x7f]/.test(value.name) || !validAvatar(value.avatar || '')) throw new Error('请填写 1–24 字昵称并使用有效头像');
  const micVolume = value.micVolume ?? 100;
  if (!Number.isInteger(micVolume) || micVolume < 0 || micVolume > 200) throw new Error('麦克风音量需要在 0–200% 之间');
  return { name: value.name.trim(), avatar: value.avatar || '', micVolume };
}
const ipv4Number = address => address.split('.').reduce((n, x) => ((n << 8) | Number(x)) >>> 0, 0);
export function inSubnet(address, cidr) {
  if (!identity.privateIPv4(address) || typeof cidr !== 'string') return false;
  const [base, bits] = cidr.split('/'); const prefix = Number(bits);
  if (!identity.privateIPv4(base) || !Number.isInteger(prefix) || prefix < 8 || prefix > 30) return false;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask);
}
async function body(req, max = 49152) {
  let length = 0; const chunks = [];
  for await (const chunk of req) { length += chunk.length; if (length > max) { throw new Error('请求过大'); } chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString());
}
function json(res, code, value) { res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(value)); }
function validateSavedState(state) {
  const device=state?.device;
  if(!device || device.deviceId!==identity.fingerprint(device.publicKey) || !state.profile) throw new Error('Invalid saved identity');
  identity.verifyObject(identity.signObject({check:true},device.privateKey,'friend-screen-storage-v1'),device.publicKey,'friend-screen-storage-v1');
  profile({...state.profile,name:state.profile.name || 'initial-setup'});
  if(state.networkId && !/^[a-f0-9]{16}$/.test(state.networkId)) throw new Error('Invalid saved network');
  if(state.group) {
    const group=state.group;
    if(group.groupId!==identity.fingerprint(group.publicKey) || group.networkId!==state.networkId || !identity.privateIPv4(group.address) || group.port!==identity.PORT || !Array.isArray(group.revoked) || group.revoked.length>1000 || group.revoked.some(v=>!/^[a-f0-9]{32}$/.test(v))) throw new Error('Invalid saved group');
    if(group.privateKey) identity.parseInvitation(identity.invitation(group));
  }
  return state;
}
export class Coordinator {
  constructor({ dataDir, root, bridgePath, secureStorage, onReady, onDisconnected }) {
    Object.assign(this, { dataDir, root, bridgePath, secureStorage, onReady, onDisconnected });
    this.state = null; this.status = { phase:'setup', message:'填写昵称、头像与管理员提供的邀请码。' };
    this.nonces = new Map(); this.busy = false; this.saveQueue = Promise.resolve(); this.connections = new Set(); this.lastRevocationPoll = 0; this.enrollmentLimits = new Map();
  }
  async load() {
    if (!this.secureStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储不可用，不能保存设备身份');
    await fs.mkdir(this.dataDir, {recursive:true});
    try { const encrypted = await fs.readFile(path.join(this.dataDir,'device-state.bin')); if(encrypted.length > 1024*1024) throw new Error(); this.state = validateSavedState(JSON.parse(this.secureStorage.decryptString(encrypted))); }
    catch (error) { if(error.code !== 'ENOENT') throw new Error('设备资料无法解密或已损坏；请保留资料并查看日志，不会自动覆盖身份'); }
    if (!this.state) { this.state = { device:identity.newIdentity(), profile:{name:'',avatar:'',micVolume:100}, group:null }; await this.save(); }
    this.timer = setInterval(() => this.poll().catch(() => {}), 8000); this.timer.unref();
  }
  async save() {
    const encrypted = this.secureStorage.encryptString(JSON.stringify(this.state));
    this.saveQueue = this.saveQueue.catch(()=>{}).then(async()=> { const target=path.join(this.dataDir,'device-state.bin'); await fs.writeFile(target+'.tmp', encrypted); await fs.rename(target+'.tmp', target); });
    return this.saveQueue;
  }
  view() {
    return { ...this.status, profile:this.state?.profile, deviceId:this.state?.device.deviceId,
      nodeId:this.nodeId || '', networkId:this.state?.networkId || '', administrator:Boolean(this.state?.group?.privateKey), administratorPending:Boolean(this.state?.administratorPending), registered:Boolean(this.state?.device?.certificate),
      invitation:this.state?.group?.privateKey && this.address ? identity.invitation(this.state.group) : '',
      members:this.state?.group?.privateKey ? (this.state.members || []).map(m=>({deviceId:m.deviceId,name:m.name,nodeId:m.nodeId})) : [],
      connected:Boolean(this.gateway), address:this.address || '' };
  }
  async bridge(operation, networkId) {
    try {
      const {stdout} = await execute(this.bridgePath, [operation, path.join(this.dataDir,'network-auth'), ...(networkId ? [networkId] : [])], {windowsHide:true,timeout:operation==='authorize'?150000:12000,maxBuffer:65536,encoding:'utf8'});
      const value=JSON.parse(stdout.replace(/^\uFEFF/, '').trim()); if(!value.ok) throw new Error(value.error); return value.result || true;
    } catch(error) {
      try { const result=JSON.parse(error.stdout?.replace(/^\uFEFF/, '').trim()); if(result.error) throw Object.assign(new Error(result.error), {safe:true}); }
      catch(parsed) { if(parsed.safe) throw parsed; }
      throw new Error('网络组件或 Windows 授权不可用，请运行完整安装包，再点击“Windows 授权”。');
    }
  }
  async authorize() { await this.bridge('authorize'); return this.view(); }
  async networkPaths(){
    if(this.pathsCache&&Date.now()-this.pathsCache.at<5000)return this.pathsCache.value;
    if(this.pathsTask)return this.pathsTask;
    this.pathsTask=(async()=>{try{
      const [peers,status]=await Promise.all([this.bridge('peers'),this.bridge('status')]);
      const value={available:true,tcpFallback:Boolean(status.tcpFallbackActive),peers:(Array.isArray(peers)?peers:[]).filter(p=>p.role==='LEAF').map(p=>({nodeId:p.address,direct:Array.isArray(p.paths)&&p.paths.some(path=>path.active===true),latency:Number.isFinite(p.latency)&&p.latency>=0?p.latency:null}))};
      this.pathsCache={at:Date.now(),value};return value;
    }catch{return{available:false,peers:[]};}finally{this.pathsTask=null;}})();return this.pathsTask;
  }
  async setup(value) {
    if(this.busy || this.settingUp || this.closed) throw new Error('正在连接，请稍候');
    if(this.state.device.certificate) throw new Error('设备已批准，请在房间页修改资料；更换小屋请先退出当前设备');
    this.settingUp=true;
    const previous=structuredClone(this.state);
    try {
    const nextProfile=profile(value);
    if(this.state.group?.privateKey && !value.administrator) throw new Error('这是管理员设备，请使用已保存的管理员设置');
    if(value.administrator) {
      if(!/^[a-f0-9]{16}$/i.test(value.networkId || '')) throw new Error('管理员请填写后台的 16 位 Network ID');
      if(this.state.networkId && this.state.networkId!==value.networkId.toLowerCase()) throw new Error('请先退出当前设备，再更换网络');
      this.state.networkId=value.networkId.toLowerCase(); this.state.administratorPending=true;
    } else {
      const code=value.invite?.trim() || this.state.invite;
      const invite=identity.parseInvitation(code);
      if(this.state.networkId && this.state.networkId!==invite.networkId) throw new Error('请先退出当前设备，再更换小屋');
      this.state.networkId=invite.networkId; this.state.invite=code;
      this.state.group={networkId:invite.networkId,address:invite.address,port:invite.port,publicKey:invite.publicKey,groupId:invite.groupId,revoked:[],revision:0};
    }
    this.state.profile=nextProfile;
    await this.bridge('join',this.state.networkId);
    await this.save();
    this.status={phase:'waiting',message:'已发起入网请求，等待管理员在后台核对本机 ZeroTier ID 后批准。'};
    } catch(error) {this.state=previous;throw error;}
    finally {this.settingUp=false;}
    await this.poll(); return this.view();
  }
  remoteAllowed(address) { return inSubnet(address,this.cidr); }
  async request(address, route, data, authenticated=true) {
    if(!this.remoteAllowed(address)) throw new Error('目标不属于本机已批准的 overlay 网段');
    const audience=`${address}:${identity.PORT}`;
    return new Promise((resolve,reject)=> {
      const encoded=data===undefined?null:Buffer.from(JSON.stringify(data));
      const req=http.request({host:address,port:identity.PORT,path:route,method:encoded?'POST':'GET',localAddress:this.address,timeout:6000,
        headers:{...(encoded?{'Content-Type':'application/json','Content-Length':encoded.length}:{}),...(authenticated?{'X-Friend-Authorization':identity.authorization(this.state.device,this.state.group,this.address,audience)}:{})}},res=> {
          let length=0, chunks=[]; res.on('data',chunk=>{length+=chunk.length;if(length>65536){req.destroy(new Error('私网响应过大'));return;}chunks.push(chunk);});
          res.on('end',()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString());if(res.statusCode!==200)reject(new Error(value.error || '私网请求被拒绝'));else resolve(value);}catch{reject(new Error('私网响应无效'));}});
        });
      req.on('timeout',()=>req.destroy(new Error('管理员电脑或房主暂时不可达，请确认对方在线并检查网络。')));req.on('error',reject);req.end(encoded);
    });
  }
  poll() {
    if(this.pollTask)return this.pollTask;
    this.pollTask=this.pollOnce().finally(()=>{this.pollTask=null;});
    return this.pollTask;
  }
  async pollOnce() {
    if(this.busy || this.settingUp || !this.state?.networkId || this.closed) return;
    this.busy=true;
    try {
      const status=await this.bridge('status'); this.nodeId=status.address;
      const net=await this.bridge('network',this.state.networkId);
      if(this.closed)return;
      if(net.status!=='OK') throw Object.assign(new Error(net.status==='ACCESS_DENIED'?'等待管理员批准；后台请选择与本机 ZeroTier ID 一致的设备。':`网络未连接（${String(net.status).slice(0,40)}），请检查网络、服务和后台成员状态。`),{waiting:net.status==='ACCESS_DENIED'});
      if(net.type!=='PRIVATE') throw new Error('仅允许私有网络；请管理员将网络设为 Private');
      const cidr=net.assignedAddresses?.find(v=>identity.privateIPv4(v.split('/')[0]));
      if(!cidr) throw new Error('私网没有分配 IPv4；请管理员在后台开启私有 IPv4 自动分配');
      const address=cidr.split('/')[0];
      const interfaces=Object.values(os.networkInterfaces()).flat().filter(Boolean);
      if(!interfaces.some(i=>i.address===address && !i.internal)) throw new Error('Windows 虚拟网卡尚未就绪，请修复安装或重启电脑');
      if(interfaces.some(i=>i.family==='IPv4' && !i.internal && i.address!==address && inSubnet(i.address,cidr))) throw new Error('overlay 网段与本机其他网卡重叠；请管理员更换私网 IPv4 地址池');
      if(this.address && this.address!==address) await this.stopServers();
      this.address=address; this.cidr=cidr;
      if(this.state.administratorPending && !this.state.group?.privateKey) {
        this.state.group=identity.makeGroup(this.state.networkId,address);
        this.state.device.certificate=identity.issueMember(this.state.group,this.state.device);
        this.state.members=[{deviceId:this.state.device.deviceId,name:this.state.profile.name,nodeId:this.nodeId}];
        this.state.administratorPending=false; await this.save();
      }
      const group=this.state.group;
      if(!group) throw new Error('请完成首次设置');
      if(group.privateKey && group.address!==address) {group.address=address;await this.save();}
      if(!this.state.device.certificate) {
        this.status={phase:'waiting',message:'私网已批准，正在向管理员验证邀请码。管理员需保持同屏小屋运行。'};
        const proof=identity.signObject({deviceId:this.state.device.deviceId,publicKey:this.state.device.publicKey,address,nodeId:this.nodeId,at:Date.now(),name:this.state.profile.name},this.state.device.privateKey,'friend-screen-enroll-v1');
        const result=await this.request(group.address,'/enroll',{invite:this.state.invite,proof},false);
        const member=identity.verifyMember(result.certificate,group);
        if(member.deviceId!==this.state.device.deviceId) throw new Error('管理员返回了不匹配的设备凭证');
        this.state.device.certificate=result.certificate;delete this.state.invite;await this.save();
      }
      identity.verifyMember(this.state.device.certificate,group);
      if(!group.privateKey && Date.now()-this.lastRevocationPoll>30000) {
        this.lastRevocationPoll=Date.now();
        try {const response=await this.request(group.address,'/revocations');const list=identity.verifyObject(response.token,group.publicKey,'friend-screen-revocations-v1');
          if(list.groupId===group.groupId && Number.isSafeInteger(list.revision) && list.revision>=(group.revision||0) && Array.isArray(list.revoked) && list.revoked.length<=1000 && list.revoked.every(v=>/^[a-f0-9]{32}$/.test(v))) {group.revoked=list.revoked;group.revision=list.revision;await this.save();}}
        catch {/* Administrator may be offline; ZeroTier membership revocation remains authoritative. */}
      }
      identity.verifyMember(this.state.device.certificate,group);
      if(this.closed)return;
      if(!this.gateway) await this.startServers();
      this.status={phase:'connected',message:'已连接私有网络，可以创建或加入房间。'};
    } catch(error) {
      const wasConnected=Boolean(this.gateway);await this.stopServers();
      this.status={phase:error.waiting?'waiting':'failed',message:error.message || '连接失败，请重试'};
      if(wasConnected) this.onDisconnected?.();
    } finally {this.busy=false;}
  }
  authenticate(req) {
    if(!this.remoteAllowed(req.socket.remoteAddress)) throw new Error('不是 overlay 地址');
    return identity.verifyAuthorization(req.headers['x-friend-authorization'],this.state.group,req.socket.remoteAddress,`${this.address}:${identity.PORT}`,this.nonces);
  }
  async handlePrivate(req,res,route) {
    if(!this.remoteAllowed(req.socket.remoteAddress)) {json(res,403,{error:'仅允许私网访问'});return;}
    const group=this.state.group;
    if(route==='/enroll' && req.method==='POST' && group.privateKey) {
      const now = Date.now();
      for (const [key, item] of this.enrollmentLimits) if (now - item.at > 60000) this.enrollmentLimits.delete(key);
      const key = req.socket.remoteAddress;
      const rate = this.enrollmentLimits.get(key) || {at:now,count:0};
      if (++rate.count > 8 || this.enrollmentLimits.size >= 128) {json(res,429,{error:'入群请求过于频繁，请一分钟后重试'});return;}
      this.enrollmentLimits.set(key,rate);
      const value=await body(req); identity.currentInvitation(value.invite,group);
      const untrusted=JSON.parse(Buffer.from(String(value.proof).split('.')[0],'base64url').toString());
      const proof=identity.verifyObject(value.proof,untrusted.publicKey,'friend-screen-enroll-v1');
      if(proof.address!==req.socket.remoteAddress || !Number.isFinite(proof.at) || Math.abs(Date.now()-proof.at)>60000 || !/^[a-f0-9]{10}$/.test(proof.nodeId)) throw new Error('入群设备证明无效');
      const p=profile({name:proof.name});
      const certificate=identity.issueMember(group,proof);
      const members=this.state.members ||=[];
      if(!members.some(m=>m.deviceId===proof.deviceId)) {if(members.length>=10) throw new Error('设备数已达本小屋上限，请管理员移除旧设备');members.push({deviceId:proof.deviceId,name:p.name,nodeId:proof.nodeId});await this.save();}
      json(res,200,{certificate});return;
    }
    if(route==='/revocations' && req.method==='GET' && group.privateKey) {
      this.authenticate(req);json(res,200,{token:identity.signObject({groupId:group.groupId,revision:group.revision||0,revoked:group.revoked},group.privateKey,'friend-screen-revocations-v1')});return;
    }
    json(res,404,{error:'私网接口不存在'});
  }
  async startServers() {
    const config=readConfig({HOST:'127.0.0.1',PORT:'0',ACCOUNT_DATA_DIR:':memory:'});
    Object.assign(config, {
      host: this.address, port: identity.PORT, maxParticipants: 8, nativeMedia:true,
      overlay: {
        authenticate: req => this.authenticate(req),
        hostProof: req => identity.hostProof(this.state.device, this.address, req.headers['x-friend-challenge']),
        isRevoked: deviceId => this.state.group.revoked.includes(deviceId),
        roomCode: () => identity.roomCode(this.state.group.groupId, this.address),
        handleHttp: async (req,res,route) => {
          try { await this.handlePrivate(req,res,route); }
          catch { json(res,400,{error:'邀请码错误、已撤销，或设备证明无效；请核对管理员提供的最新邀请码。'}); }
        },
      },
    });
    this.roomService=createApp(config);await this.roomService.listen();
    await this.startGateway();
    this.onReady?.(`http://127.0.0.1:${this.gateway.address().port}`);
  }
  async startGateway() {
    const sockets=this.connections;
    this.gateway=http.createServer(async(req,res)=> {
      const origin=`http://127.0.0.1:${this.gateway?.address()?.port}`;
      if(req.headers.host!==origin.slice(7)){json(res,421,{error:'Unknown host'});return;}
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
      res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');
      try {
        const route=new URL(req.url,origin).pathname;
        if(req.method==='POST' && req.headers.origin!==origin) {json(res,403,{error:'Origin rejected'});return;}
        if(route==='/api/config' && req.method==='GET'){json(res,200,{overlay:true,nativeMedia:true,address:this.address,maxParticipants:8,requiresAccessKey:false,hasTurn:false});return;}
        if(route==='/api/device' && req.method==='GET'){json(res,200,{profile:this.state.profile,deviceId:this.state.device.deviceId});return;}
        if(route==='/api/network-paths' && req.method==='GET'){json(res,200,await this.networkPaths());return;}
        if(route==='/api/device/profile' && req.method==='POST'){this.state.profile=profile(await body(req));await this.save();json(res,200,{profile:this.state.profile});return;}
        if(route==='/api/device/exit' && req.method==='POST'){json(res,200,{ok:true});this.onDisconnected?.(true);return;}
        const file=assets.get(route);if(!file || req.method!=='GET'){json(res,404,{error:'Not found'});return;}
        let bytes=await fs.readFile(path.join(this.root,'public',file[0]));
        if(file[0]==='index.html') bytes=Buffer.from(bytes.toString().replace('<script src="/app.js" defer></script>','<script type="module" src="/app.js"></script>'));
        res.writeHead(200,{'Content-Type':file[1].startsWith('text/') ? file[1]+'; charset=utf-8' : file[1]});res.end(bytes);
      } catch(error){if(!res.headersSent)json(res,400,{error:'本机操作失败，请重试'});else res.end();}
    });
    this.gateway.requestTimeout=10000;this.gateway.headersTimeout=8000;
    this.proxyWss=new WebSocketServer({noServer:true,maxPayload:65536,perMessageDeflate:false});
    this.gateway.on('upgrade',(req,socket,head)=>{
      const origin=`http://127.0.0.1:${this.gateway?.address()?.port}`;
      try {
        if(req.headers.host!==origin.slice(7) || req.headers.origin!==origin || this.proxyWss.clients.size>=8) throw new Error();
        const url=new URL(req.url,origin);if(url.pathname!=='/ws') throw new Error();
        const room=url.searchParams.get('room');const target=room?identity.parseRoomCode(room,this.state.group.groupId):{address:this.address,port:identity.PORT};
        if(!this.remoteAllowed(target.address)) throw new Error();
        this.proxyWss.handleUpgrade(req,socket,head,client=>{
          const audience=`${target.address}:${target.port}`;
          const challenge = randomBytes(32).toString('hex');
          const remote=new WebSocket(`ws://${audience}/ws`,{origin:`http://${audience}`,localAddress:this.address,handshakeTimeout:6000,maxPayload:65536,perMessageDeflate:false,headers:{'X-Friend-Authorization':identity.authorization(this.state.device,this.state.group,this.address,audience,this.nodeId),'X-Friend-Challenge':challenge}});
          sockets.add(client);sockets.add(remote);let pending=[],size=0,verified=false;
          const proofTimeout=setTimeout(()=>end(),8000);
          const end=()=>{clearTimeout(proofTimeout);sockets.delete(client);sockets.delete(remote);client.terminate();remote.terminate();};
          client.on('message',(data,binary)=>{if(binary || data.length>65536 || remote.bufferedAmount>1048576){end();return;}if(verified && remote.readyState===WebSocket.OPEN)remote.send(data.toString());else{size+=data.length;if(size>65536){end();return;}pending.push(data.toString());}});
          remote.on('message',(data,binary)=>{
            if(binary || client.bufferedAmount>1048576){end();return;}
            if(!verified) {
              try {
                const message=JSON.parse(data.toString());
                if(message.type!=='host-proof')throw new Error();
                identity.verifyHostProof(message.token,this.state.group,target.address,challenge);
                verified=true;clearTimeout(proofTimeout);
                for(const message of pending)remote.send(message);pending=[];
              }catch{end();}
              return;
            }
            if(client.readyState===WebSocket.OPEN)client.send(data.toString());
          });
          remote.on('error',()=>{if(client.readyState===WebSocket.OPEN)client.send(JSON.stringify({type:'error',code:'HOST_UNREACHABLE',message:'房主不可达或设备未获批准。请检查房间号、房主是否在线及网络状态。'}));client.close(1011,'host unavailable');});
          client.on('error',end);client.on('close',end);remote.on('close',()=>{clearTimeout(proofTimeout);client.close(1000,'host disconnected');});
        });
      }catch{socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');}
    });
    await new Promise((resolve,reject)=>{this.gateway.once('error',reject);this.gateway.listen(0,'127.0.0.1',resolve);});
  }
  async adminAction(value) {
    const group=this.state.group;if(!group?.privateKey)throw new Error('只有管理员能执行此操作');
    if(value.type==='rotate') {group.invitationVersion=randomBytes(12).toString('hex');group.invitationSecret=randomBytes(32).toString('base64url');}
    else if(value.type==='remove') {
      if(value.deviceId===this.state.device.deviceId || !this.state.members?.some(m=>m.deviceId===value.deviceId))throw new Error('请选择其他已批准设备');
      if(!group.revoked.includes(value.deviceId))group.revoked.push(value.deviceId);group.revision=(group.revision||0)+1;
      this.state.members=this.state.members.filter(m=>m.deviceId!==value.deviceId);
    }else throw new Error('不支持的管理员操作');
    await this.save();return this.view();
  }
  async stopServers() {
    for(const socket of this.connections)socket.terminate();this.connections.clear();
    if(this.proxyWss){this.proxyWss.close();this.proxyWss=null;}
    if(this.gateway){const server=this.gateway;this.gateway=null;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    if(this.roomService){await this.roomService.close();this.roomService=null;}
  }
  async logout() {
    if(this.busy || this.settingUp)throw new Error('网络操作进行中，请稍后退出');
    this.settingUp=true;
    try {
    await this.stopServers();
    if(this.state.networkId)await this.bridge('leave',this.state.networkId);
    this.state={device:identity.newIdentity(),profile:{name:'',avatar:'',micVolume:100},group:null};this.address=null;this.cidr=null;await this.save();this.status={phase:'setup',message:'已退出当前设备，需要重新填写首次设置。'};
    return this.view();
    } finally {this.settingUp=false;}
  }
  async close(){this.closed=true;clearInterval(this.timer);await this.pollTask;await this.stopServers();await this.saveQueue;}
}
