// Test-only encrypted UDP hop, bound to this computer's existing private IP.
// No media is decrypted or saved. Production packaging excludes test/.
import dgram from 'node:dgram';

export function privateMediaLink(address){
  const profile=process.env.FRIEND_LINK_PROFILE||'loss-reorder';
  if(!['delay','drop','reorder','loss-reorder'].includes(profile))throw Error('Invalid link fixture profile');
  const dropEvery=['delay','reorder'].includes(profile)?0:800,reorderEvery=['delay','drop'].includes(profile)?0:200;
  const routes=new Map(),timers=new Set();let closed=false;
  const counts={datagrams:0,primaryVideo:0,droppedVideo:0,delayedVideo:0,queueOverflow:0,writeErrors:0};
  async function route(id,from,to){
    if(routes.has(id))return routes.get(id);
    if(routes.size>=8)throw Error('Test media route bound exceeded');
    const pending=(async()=>{
      const endpoints=new Map([[from,{port:null}],[to,{port:null}]]);
      for(const [owner,endpoint] of endpoints){
        const socket=dgram.createSocket({type:'udp4',recvBufferSize:4*1024*1024,sendBufferSize:4*1024*1024});endpoint.socket=socket;
        await new Promise((resolve,reject)=>{socket.once('error',reject);socket.bind(0,address,resolve);});
        endpoint.advertisedPort=socket.address().port;
        socket.on('error',()=>{counts.writeErrors++;});
        socket.on('message',(packet,remote)=>{
          const other=endpoints.get(owner===from?to:from);
          if(closed||!endpoint.port||!other.port||remote.address!==address||remote.port!==other.port)return;
          counts.datagrams++;let delay=14;
          // Native H.264 primary payload is 102. Audio, RTX, DTLS and STUN
          // retain the same baseline latency and are not intentionally lost.
          if(packet.length>=12&&(packet[0]&0xc0)===0x80&&(packet[1]&0x7f)===102){
            counts.primaryVideo++;
            if(dropEvery&&counts.primaryVideo%dropEvery===0){counts.droppedVideo++;return;}
            if(reorderEvery&&counts.primaryVideo%reorderEvery===0){counts.delayedVideo++;delay+=80;}
          }
          if(timers.size>=4096){counts.queueOverflow++;return;}
          const timer=setTimeout(()=>{
            timers.delete(timer);if(closed)return;
            other.socket.send(packet,endpoint.port,address,error=>{if(error&&!closed)counts.writeErrors++;});
          },delay);timers.add(timer);
        });
      }
      return endpoints;
    })();routes.set(id,pending);return pending;
  }
  return{
    async rewrite(from,raw){
      const message=JSON.parse(raw);
      if(message.type!=='screen-signal')return raw;
      const endpoints=await route(message.connectionId,from,message.to),endpoint=endpoints.get(from);
      if(!endpoint)throw Error('Unexpected media proxy participant');
      const candidate=line=>{
        const cr=line.endsWith('\r')?'\r':'',parts=line.trim().split(/\s+/);
        if(parts[2]?.toLowerCase()!=='udp'||parts[4]!==address)return line;
        const port=Number(parts[5]);if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid private fixture candidate');
        endpoint.port=port;parts[5]=String(endpoint.advertisedPort);return parts.join(' ')+cr;
      };
      if(message.payload?.description?.sdp)message.payload.description.sdp=message.payload.description.sdp.replace(/^a=candidate:.*$/gm,candidate);
      if(message.payload?.candidate?.candidate)message.payload.candidate.candidate=candidate(message.payload.candidate.candidate);
      return JSON.stringify(message);
    },
    snapshot(){return{...counts,delayMs:14,profile,dropEveryPrimaryVideoPacket:dropEvery,reorderEveryPrimaryVideoPacket:reorderEvery,extraReorderDelayMs:80};},
    async close(){closed=true;for(const timer of timers)clearTimeout(timer);timers.clear();for(const pending of routes.values()){const endpoints=await pending;for(const endpoint of endpoints.values())await new Promise(r=>endpoint.socket.close(r));}},
  };
}
