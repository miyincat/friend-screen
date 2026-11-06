import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {createApp,readConfig} from '../server.mjs';
import {roomCode,parseRoomCode} from '../network/identity.mjs';

for(const nativeMedia of [false,true]) test('overlay 房间协议：8 人、超员、同名、重连、单路共享、离房关闭 · 原生 '+nativeMedia, {timeout:15000}, async t=>{
  // Protocol integration over loopback, with authentication mocked explicitly.
  // This does NOT exercise a real ZeroTier adapter or cross-network media.
  const sockets=[],groupId='a'.repeat(32),revoked=new Set();
  const config=readConfig({PORT:'0',ACCOUNT_DATA_DIR:':memory:'});
  Object.assign(config,{maxParticipants:8,nativeMedia,overlay:{
    authenticate:req=>{if(req.headers['x-test-device']==='denied')throw new Error();return {deviceId:req.headers['x-test-device'],address:'127.0.0.1'};},
    hostProof:()=> 'test-proof',isRevoked:id=>revoked.has(id),roomCode:()=>roomCode(groupId,'10.147.20.1'),
    handleHttp:async(req,res)=>{res.writeHead(404);res.end();},
  }});
  const app=createApp(config),port=await app.listen(),base=`http://127.0.0.1:${port}`;
  t.after(async()=>{sockets.forEach(s=>s.terminate());await app.close();});
  async function connect(id) {
    const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`,{origin:base,headers:{'X-Test-Device':id}});sockets.push(ws);ws.on('error',()=>{});
    const inbox=[],waiters=[];
    ws.on('message',data=>{const m=JSON.parse(data),i=waiters.findIndex(w=>w.type===m.type);if(i<0)inbox.push(m);else {const w=waiters.splice(i,1)[0];clearTimeout(w.timer);w.resolve(m);}});
    await once(ws,'open');
    const next=type=>new Promise((resolve,reject)=>{const i=inbox.findIndex(m=>m.type===type);if(i>=0)return resolve(inbox.splice(i,1)[0]);const w={type,resolve};w.timer=setTimeout(()=>reject(new Error('Timeout: '+type)),2000);waiters.push(w);});
    t.after(()=>waiters.forEach(w=>clearTimeout(w.timer)));
    assert.equal((await next('host-proof')).token,'test-proof');return {ws,next,send:m=>ws.send(JSON.stringify({...m,...(nativeMedia?{nativeMediaVersion:1}:{})}))};
  }
  const host=await connect('0'.repeat(32));host.send({type:'create',name:'朋友'});const first=await host.next('joined');
  assert.equal(first.maxParticipants,8);assert.equal(first.overlay,true);assert.equal(parseRoomCode(first.roomId,groupId).address,'10.147.20.1');
  assert.deepEqual(first.iceServers,[]);
  const guests=[];
  for(let i=1;i<=7;i++){const peer=await connect(i.toString(16).repeat(32));peer.send({type:'join',name:'朋友',roomId:first.roomId});const joined=await peer.next('joined');assert.equal(joined.displayName,'朋友-'+i.toString(16).repeat(4));guests.push(peer);}
  const extra=await connect('9'.repeat(32));extra.send({type:'join',name:'超员',roomId:first.roomId});assert.equal((await extra.next('error')).code,'ROOM_FULL');
  const replacement=await connect('1'.repeat(32));replacement.send({type:'join',name:'重连',roomId:first.roomId});assert.equal((await replacement.next('joined')).peers.length,7);
  host.send({type:'present',active:true,shareId:'private_share_test'});assert.equal((await host.next('presenter')).peerId,first.selfId);
  replacement.send({type:'present',active:true,shareId:'private_share_other'});assert.equal((await replacement.next('error')).code,'PRESENTER_BUSY');
  replacement.send({type:'signal',to:first.selfId,payload:{candidate:{candidate:'candidate:1 1 udp 123 8.8.8.8 50000 typ host'}}});assert.equal((await replacement.next('error')).code,'BAD_SIGNAL');
  if(nativeMedia){
    let tree;do{tree=await host.next('media-tree');}while(!tree.shareId);
    assert.equal(tree.edges.length,7);assert.ok(Object.values(tree.addresses).every(a=>a==='127.0.0.1'));
    const route=tree.edges.find(e=>e.from===first.selfId),receiver=route.to==='1'.repeat(32)?replacement:guests[Number(route.to[0])-1];
    host.send({type:'screen-signal',to:route.to,shareId:tree.shareId,connectionId:route.connectionId,payload:{candidate:{candidate:'candidate:1 1 udp 123 8.8.8.8 50000 typ host'}}});
    assert.equal((await host.next('error')).code,'BAD_SIGNAL');
    host.send({type:'screen-signal',to:route.to,shareId:tree.shareId,connectionId:route.connectionId,payload:{candidate:{candidate:'candidate:1 1 udp 123 127.0.0.1 50000 typ host'}}});
    assert.equal((await receiver.next('screen-signal')).from,first.selfId);
    const mediaSignal = { type: 'screen-signal', to: route.to, shareId: tree.shareId, connectionId: route.connectionId };
    const profile = {
      resolution: { width: 2560, height: 1440 },
      maxFramerate: 60,
      maxBitrate: 6000000,
      maxAudioBitrate: 192000,
      degradationPreference: 'maintain-resolution',
    };
    host.send({ ...mediaSignal, payload: { description: { type: 'offer', sdp: 'v=0\r\n', profile } } });
    assert.deepEqual((await receiver.next('screen-signal')).payload.description.profile, profile);
    const customProfile = { ...profile, maxFramerate: 45 };
    host.send({ ...mediaSignal, payload: { profile: customProfile } });
    assert.deepEqual((await receiver.next('screen-signal')).payload.profile, customProfile);
    for (const maxFramerate of [14, 60.5, 61]) {
      host.send({ ...mediaSignal, payload: { profile: { ...profile, maxFramerate } } });
      assert.equal((await host.next('error')).code, 'BAD_SIGNAL');
    }
    for (const resolution of [{ width: 2562, height: 1440 }, { width: 2560, height: 1442 }]) {
      host.send({ ...mediaSignal, payload: { profile: { ...profile, resolution } } });
      assert.equal((await host.next('error')).code, 'BAD_SIGNAL');
    }
    replacement.ws.send(JSON.stringify({type:'screen-signal',to:guests[2].ws.id||'4'.repeat(32),shareId:tree.shareId,connectionId:route.connectionId,payload:{candidate:null}}));
    assert.equal((await replacement.next('error')).code,'STALE_MEDIA_ROUTE');
  }
  replacement.send({type:'mic',active:true});assert.equal((await host.next('peer-state')).mic,true);
  host.send({type:'leave'});assert.match((await replacement.next('room-closed')).message,/房主/);
  extra.send({type:'join',name:'旧房间',roomId:first.roomId});assert.equal((await extra.next('error')).code,'JOIN_DENIED');
  const newHost=guests[1]; // Its old socket closes when the room closes; reconnect as new owner.
  const owner2=await connect('2'.repeat(32));owner2.send({type:'create',name:'第二位房主'});assert.ok((await owner2.next('joined')).roomId);
});
