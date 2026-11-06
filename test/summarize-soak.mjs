import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
const input='artifacts/overlay-tests/seven-client-loopback.json';
const result=JSON.parse(await readFile(input,'utf8'));
assert.equal(result.passed,true);assert.equal(result.samples.length,60);assert.ok(result.durationSeconds>=600);assert.deepEqual(result.errors,[]);
const samples=result.samples,first=samples[0],last=samples.at(-1);
let stalls=0,deltaBytes=0,totalCpuSeconds=0,previousSeconds=0;
for(let i=0;i<samples.length;i++){
  const sample=samples[i];assert.equal(sample.clients.length,7);assert.ok(sample.clients.every(c=>c.connected===6));
  totalCpuSeconds+=sample.cpuOneCorePercent/100*(sample.seconds-previousSeconds);previousSeconds=sample.seconds;
  if(i)for(let j=1;j<7;j++)if(sample.clients[j].framesDecoded<=samples[i-1].clients[j].framesDecoded)stalls++;
}
assert.equal(stalls,0,'Every receiver must continue decoding across every 10-second sample');
for(let j=0;j<7;j++)deltaBytes+=last.clients[j].bytesSent-first.clients[j].bytesSent;
const elapsed=last.seconds-first.seconds;
const summary={passed:true,environment:result.environment,durationSeconds:result.durationSeconds,sampleCount:samples.length,receivers:6,stalledReceiverIntervals:stalls,logicalCpus:last.logicalCpus,averageBrowserCpuOneCorePercent:100*totalCpuSeconds/last.seconds,averageBrowserCpuMachinePercent:100*totalCpuSeconds/last.seconds/last.logicalCpus,averageAllClientsOutboundMbps:deltaBytes*8/elapsed/1e6,averageSharerOutboundMbps:(last.clients[0].bytesSent-first.clients[0].bytesSent)*8/elapsed/1e6,receiverAverageFps:last.clients.slice(1).map((c,i)=>(c.framesDecoded-first.clients[i+1].framesDecoded)/elapsed),limits:'Single computer, simple synthetic content, loopback; excludes ZeroTier overhead and other device/network behavior. CPU covers the test browser processes, not a physical remote client.'};
await writeFile('artifacts/overlay-tests/seven-client-summary.json',JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
