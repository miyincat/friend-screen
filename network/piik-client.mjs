import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import WebSocket from 'ws';

export const PUBLIC_COMMANDS = new Set(['capture-options','list-sources','source-preview','start-share','update-share','stop-share','prepare-edge','prepare-local-edge','edge-answer','edge-candidate','close-edge','receive-offer','receive-candidate','close-receiver','stop-receive']);
export class PiikClient extends EventEmitter {
  constructor({ directory, dataDir, site='http://127.0.0.1', address, test=false }) { super(); this.directory=directory; this.dataDir=dataDir; this.site=site; this.address=address;this.test=test;this.pending=new Map(); this.child=null; this.socket=null; this.starting=null; this.closing=false; }
  async start() {
    if(this.closing)throw new Error('媒体组件已经关闭');
    if(this.socket?.readyState===WebSocket.OPEN)return;
    if(this.starting)return this.starting;
    this.starting=this.launch().finally(()=>{this.starting=null;});return this.starting;
  }
  async launch() {
    await fs.mkdir(this.dataDir,{recursive:true});
    if(this.closing)throw new Error('媒体组件已经关闭');
    this.configPath=path.join(this.dataDir,'session-'+randomUUID()+'.json');
    if(!this.address)throw new Error('私网地址尚未验证，不能启动原生媒体');
    const child=spawn(path.join(this.directory,'piik-app.exe'),['--config',this.configPath,'--site',this.site],{cwd:this.directory,windowsHide:true,env:{...process.env,PIIK_CLIENT_GATE_NO_BROWSER:'true',FRIEND_SCREEN_MEDIA_IPV4:this.address,FRIEND_SCREEN_MEDIA_TEST_ALLOW_LOOPBACK:this.test?'1':''},stdio:['pipe','pipe','pipe']});
    this.child=child;
    child.stdin.on('error',()=>{});
    // Never persist stdout: the endpoint contains an ephemeral local control token.
    const endpoint=await new Promise((resolve,reject)=>{
      let buffer='';const timer=setTimeout(()=>reject(new Error('Piik 引擎启动超时，请查看 Windows 安全软件是否拦截组件')),45000);
      const fail=()=>{clearTimeout(timer);reject(new Error('Piik 引擎无法启动，请重新安装完整客户端'));};
      child.once('error',fail);child.once('exit',fail);
      child.stdout.on('data',chunk=>{
        buffer+=chunk.toString();if(buffer.length>65536)buffer=buffer.slice(-32768);
        let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);try{
          const value=JSON.parse(line);
          if(value.host && value.port>=39721 && value.port<=39730 && /^[A-Za-z0-9_-]{43}$/.test(value.instanceToken) && value.url===`http://127.0.0.1:${value.port}`){clearTimeout(timer);resolve(value);}
        }catch{}}
      });
      child.stderr.on('data',()=>{});
    }).catch(error=>{child.kill();throw error;});
    const health=await fetch(endpoint.url+'/health',{signal:AbortSignal.timeout(5000)}).then(r=>r.json());
    if(this.closing){child.kill();throw new Error('媒体组件已经关闭');}
    if(health.protocol!==10 || health.service!=='piik-client' || health.instanceToken!==endpoint.instanceToken)throw new Error('Piik 引擎版本不兼容，需要 2.5.3 / 协议 10');
    this.health={version:health.version,nativeMedia:health.nativeMedia};
    const ws=new WebSocket(endpoint.url.replace('http:','ws:')+'/control','piik-client-v10.'+endpoint.instanceToken,{maxPayload:512*1024,handshakeTimeout:5000});
    this.socket=ws;
    ws.on('message',raw=>{try{const msg=JSON.parse(raw);const request=this.pending.get(msg.id);if(request){clearTimeout(request.timer);this.pending.delete(msg.id);if(msg.type==='request-failed')request.reject(new Error(msg.code==='source-canceled'?'已取消屏幕选择':'Piik 无法完成 '+request.type+'；请换一个窗口或编码器后重试'));else request.resolve(request.type==='prepare-local-edge'?{...msg,privateAddress:this.address}:msg);}else if(!msg.id)this.emit('event',msg);}catch{}});
    ws.on('error',()=>{});
    ws.on('close',()=>{clearInterval(this.heartbeat);for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Piik 媒体引擎已断开'));}this.pending.clear();if(!this.closing)this.emit('event',{type:'engine-disconnected'});});
    await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',()=>reject(new Error('无法连接本机 Piik 引擎')));});
    await this.request('hello',{});
    this.heartbeat=setInterval(()=>this.request('ping',{}).catch(()=>{}),15000);this.heartbeat.unref();
  }
  async request(type, payload={}) {
    if(this.socket?.readyState!==WebSocket.OPEN)throw new Error('Piik 引擎尚未就绪');
    const id=randomUUID();
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Piik '+type+' 超时，请停止共享后重试'));},type==='start-share'?45000:12000);this.pending.set(id,{resolve,reject,timer,type});this.socket.send(JSON.stringify({...payload,version:10,id,type}));});
  }
  async command(type,payload) {
    if(!PUBLIC_COMMANDS.has(type))throw new Error('未允许的媒体操作');
    if(JSON.stringify(payload??{}).length>160000)throw new Error('媒体请求过大');
    await this.start();return this.request(type,payload);
  }
  async close() {
    this.closing=true;clearInterval(this.heartbeat);this.socket?.close();
    const child=this.child;this.child=null;if(!child)return;
    if(child.exitCode===null&&!child.stdin.destroyed)child.stdin.write('\n');
    await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve();},2500);child.once('exit',()=>{clearTimeout(timer);resolve();});});
    if(this.configPath)await fs.rm(this.configPath,{force:true}).catch(()=>{});
  }
}
