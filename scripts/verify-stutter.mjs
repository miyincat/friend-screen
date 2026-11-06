// Verify the recorded, isolated native-media regression rather than UI labels.
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {unzipSync,strFromU8} from 'fflate';
const root=path.resolve('artifacts/stutter-0.3.9');
const median=a=>{const s=a.filter(Number.isFinite).sort((a,b)=>a-b);return s.length?s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2:null;};
async function measure(name){
  const result=JSON.parse(await readFile(path.join(root,name,'results.json'),'utf8'));assert.equal(result.passed,true,name);
  const files=unzipSync(await readFile(result.viewerZip));
  const samples=strFromU8(files['samples.jsonl']).trim().split(String.fromCharCode(10)).map(JSON.parse);
  const video=s=>s.renderer?.media?.localPlayback?.find(t=>t.direction==='inbound-rtp'&&t.kind==='video');
  const rows=samples.filter(s=>s.renderer?.role==='viewing'&&Number.isFinite(video(s)?.timestamp)&&video(s).framesDecoded>0);
  assert.ok(rows.length>=5,name+' media samples');
  const first=video(rows[0]),last=video(rows.at(-1)),duration=(last.timestamp-first.timestamp)/1000;
  assert.ok(duration>10);
  const edges=rows.flatMap(s=>s.native||[]).filter(n=>n.diagnostics?.scope==='local-playback'&&n.diagnostics.queue);
  assert.ok(edges.length);const qa=edges[0].diagnostics.queue,qb=edges.at(-1).diagnostics.queue;
  const audio=rows.at(-1).renderer.media.localPlayback.find(t=>t.kind==='audio');
  return{name,version:JSON.parse(strFromU8(files['session.json'])).version,h264Buffer:result.h264Buffer||'legacy',durationSeconds:duration,
    width:last.frameWidth,height:last.frameHeight,minWidth:Math.min(...rows.map(s=>video(s).frameWidth)),minHeight:Math.min(...rows.map(s=>video(s).frameHeight)),fpsMedian:median(rows.map(s=>s.renderer.media.actual.framesPerSecond)),
    decodedFPS:(last.framesDecoded-first.framesDecoded)/duration,mbpsMedian:median(rows.map(s=>s.renderer.media.mbps)),
    freezeCount:last.freezeCount-first.freezeCount,freezeSeconds:last.totalFreezesDuration-first.totalFreezesDuration,
    nackMessages:last.nackCount-first.nackCount,packetsLostNet:last.packetsLost-first.packetsLost,
    queueMeanMs:(qb.totalQueueResidenceMs-qa.totalQueueResidenceMs)/(qb.dequeuedPackets-qa.dequeuedPackets),
    pacing:qb.pacing||'network-paced',queueOverflow:qb.overflowDrops-qa.overflowDrops,writeErrors:qb.writeErrors-qa.writeErrors,
    sharedAudioEnergy:audio?.totalAudioEnergy,impairment:result.impairedLink,viewerZip:result.viewerZip,hostZip:result.hostZip};
}
const cases=[];for(const name of ['before-1080','fixed-1080','after-1080'])cases.push(await measure(name));
const old=cases.find(c=>c.name==='before-1080'),fixed=cases.find(c=>c.name==='fixed-1080'),healthy=cases.find(c=>c.name==='after-1080');
for(const c of [fixed,healthy]){
  assert.ok(c.fpsMedian>=50&&c.decodedFPS>=45,c.name+' delivered frame rate');
  assert.ok(c.minWidth>=1900&&c.minHeight>=1070,c.name+' preserved resolution');
  assert.equal(c.pacing,'local-direct');assert.ok(c.queueMeanMs<5,c.name+' local delivery delay');
  assert.equal(c.queueOverflow,0);assert.equal(c.writeErrors,0);assert.ok(c.sharedAudioEnergy>0,c.name+' shared audio');
}
assert.ok(fixed.fpsMedian>old.fpsMedian*10,'controlled recovery improvement');
for(const key of ['delayMs','dropEveryPrimaryVideoPacket','reorderEveryPrimaryVideoPacket','extraReorderDelayMs'])assert.equal(fixed.impairment[key],old.impairment[key],key);
assert.equal(fixed.impairment.queueOverflow,0);assert.equal(fixed.impairment.writeErrors,0);
const report={passed:true,recordedAt:new Date().toISOString(),cases,limits:'One Windows computer, isolated clients, synthetic 1080-class video and audio. Controlled encrypted UDP delay/loss/reordering is not a real two-network acceptance test. FPS is decoded frame rate; bitrate varies with content and repair.'};
await writeFile(path.join(root,'comparison.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
