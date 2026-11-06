import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomBytes} from 'node:crypto';
import {WebSocketServer,WebSocket} from 'ws';
import {createApp,readConfig} from '../server.mjs';
import {roomCode} from '../network/identity.mjs';
import {privateMediaLink} from './private-media-link.mjs';

export async function privateFixture(root,{impairedMedia=false}={}){
  const address=Object.entries(os.networkInterfaces()).find(([name,values])=>/zerotier/i.test(name)&&values.some(v=>v.family==='IPv4'))?.[1].find(v=>v.family==='IPv4')?.address;
  if(!address)throw Error('No existing ZeroTier IPv4 adapter; actual private binding test unavailable.');
  const mediaLink=impairedMedia?privateMediaLink(address):null,errors=[];
  const devices=new Map(),gateways=[],sockets=new Set(),group='a'.repeat(32);
  const config=readConfig({PORT:'0',ACCOUNT_DATA_DIR:':memory:'});
  Object.assign(config,{host:address,nativeMedia:true,maxParticipants:8,overlay:{
    authenticate:req=>{const id=req.headers['x-test-device'];if(!devices.has(id))throw Error('Denied fixture identity');return{deviceId:id,address};},
    hostProof:()=> 'explicit-test-mock',isRevoked:()=>false,roomCode:()=>roomCode(group,address),
    handleHttp:async(_req,res)=>{res.writeHead(404);res.end();},
  }});
  const app=createApp(config),port=await app.listen();
  const assets={'/':'index.html','/profile.js':'device-profile.js','/media-policy.js':'../network/media-policy.mjs',
    '/share-settings.js':'share-settings.js','/source-picker.js':'source-picker.js','/share-settings.css':'share-settings.css',
    '/share-art-gold.jpg':'share-art-gold.jpg','/share-art-teal.jpg':'share-art-teal.jpg','/share-art-sakura.jpg':'share-art-sakura.jpg'};
  async function gateway(label){
    const id=randomBytes(16).toString('hex');devices.set(id,true);let profile={name:label,avatar:'',micVolume:100};
    const server=http.createServer(async(req,res)=>{
      const json=v=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(v));};
      if(req.url==='/api/config')return json({overlay:true,nativeMedia:true,address,maxParticipants:8,requiresAccessKey:false,hasTurn:false});
      if(req.url==='/api/device')return json({profile,deviceId:id});
      if(req.url==='/api/network-paths')return json({available:false,peers:[]});
      if(req.url==='/api/device/profile'){const chunks=[];for await(const c of req)chunks.push(c);profile=JSON.parse(Buffer.concat(chunks));return json({profile});}
      const file=assets[req.url]||({'/app.js':'app.js','/piik-media.js':'piik-media.js','/media-controls.js':'media-controls.js','/diagnostic-telemetry.js':'diagnostic-telemetry.js','/pending-signals.js':'pending-signals.js','/styles.css':'styles.css'})[req.url];
      if(!file){res.writeHead(404);res.end();return;}
      res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css':file.endsWith('.jpg')?'image/jpeg':'text/javascript');res.end(await fs.readFile(path.join(root,'public',file)));
    });
    const wss=new WebSocketServer({server});
    wss.on('connection',local=>{
      sockets.add(local);const remote=new WebSocket(`ws://${address}:${port}/ws`,{localAddress:address,origin:`http://${address}:${port}`,headers:{'X-Test-Device':id}});sockets.add(remote);const pending=[];
      let signaling=Promise.resolve();
      local.on('message',v=>{signaling=signaling.then(async()=>{const text=mediaLink?await mediaLink.rewrite(id,v.toString()):v.toString();if(remote.readyState===WebSocket.OPEN)remote.send(text);else pending.push(text);}).catch(error=>{errors.push(error.message);local.close();});});
      remote.on('open',()=>pending.forEach(v=>remote.send(v)));
      remote.on('message',v=>{if(local.readyState===WebSocket.OPEN)local.send(v.toString());});
      remote.on('error',()=>local.close());remote.on('close',()=>local.close());local.on('close',()=>remote.close());
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));gateways.push({server,wss});return `http://127.0.0.1:${server.address().port}`;
  }
  return{address,gateway,mediaEvidence:()=>mediaLink?.snapshot()||null,errors,async close(){for(const s of sockets)s.terminate();for(const g of gateways){g.wss.close();await new Promise(r=>g.server.close(r));}await app.close();await mediaLink?.close();}};
}
