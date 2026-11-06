import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPair, inspectMediaPath, verifiedPair, overlayCandidate } from '../network/media-policy.mjs';

const own = '10.147.20.1', peer = '10.147.20.2';
function fixture(ownAddress = own, peerAddress = peer) {
  return new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['pair', { type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'local', remoteCandidateId: 'remote' }],
    ['local', { type: 'local-candidate', candidateType: 'host', protocol: 'udp', address: ownAddress }],
    ['remote', { type: 'remote-candidate', candidateType: 'host', protocol: 'udp', address: peerAddress }],
  ]);
}
function status(reports, expected, ownAddress = own, peerAddress = peer) {
  const result = inspectPair(reports, ownAddress, peerAddress);
  assert.equal(result.status, expected);
  assert.equal(typeof result.reason, 'string');
  assert.equal(verifiedPair(reports, ownAddress, peerAddress), expected === 'verified');
}

test('路径状态：完整且精确匹配的 overlay UDP host 通过', () => {
  status(fixture(), 'verified');
});

test('路径状态：缺少报告、选中 pair、候选记录均等待，不误判拒绝', () => {
  status(new Map(), 'pending');
  for (const key of ['pair', 'local', 'remote']) {
    const reports = fixture(); reports.delete(key);
    status(reports, 'pending');
  }
  const noSelection = fixture();
  delete noSelection.get('transport').selectedCandidatePairId;
  delete noSelection.get('pair').nominated;
  status(noSelection, 'pending');
});

test('路径状态：尚未成功的 pair 等待，包括暂缺状态', () => {
  for (const state of ['frozen', 'waiting', 'in-progress', 'failed']) {
    const reports = fixture(); reports.get('pair').state = state;
    status(reports, 'pending');
  }
  const reports = fixture(); delete reports.get('pair').state;
  status(reports, 'pending');
});

test('路径状态：缺少 candidate ID 时等待', () => {
  for (const key of ['localCandidateId', 'remoteCandidateId']) {
    const reports = fixture(); delete reports.get('pair')[key];
    status(reports, 'pending');
  }
});

test('路径状态：候选的地址、协议或类型暂缺时等待', () => {
  for (const side of ['local', 'remote']) for (const key of ['address', 'protocol', 'candidateType']) {
    const reports = fixture(); delete reports.get(side)[key];
    status(reports, 'pending');
  }
});

test('路径状态：兼容统计记录的 ip 字段及 UDP 大小写', () => {
  const reports = fixture();
  for (const side of ['local', 'remote']) {
    const candidate = reports.get(side); candidate.ip = candidate.address; delete candidate.address; candidate.protocol = 'UDP';
  }
  status(reports, 'verified');
});

test('路径状态：明确不符本机或朋友地址的路径拒绝', () => {
  for (const side of ['local', 'remote']) for (const address of ['10.147.20.3', '192.168.1.5', '172.16.0.7', '8.8.8.8', '127.0.0.1', '169.254.1.2']) {
    const reports = fixture(); reports.get(side).address = address;
    status(reports, 'rejected');
  }
});

test('路径状态：精确匹配仍必须是合法 RFC1918 IPv4', () => {
  for (const address of ['8.8.8.8', '100.64.0.1', '127.0.0.1', '169.254.1.2', '172.15.1.1', '172.32.0.1', '192.167.1.1', '192.169.1.1', '10.147.20.999', '10.147.20.01', '10.147.20', 'hidden.local', '::1', '::ffff:10.147.20.1']) {
    status(fixture(address, peer), 'rejected', address, peer);
    status(fixture(own, address), 'rejected', own, address);
  }
});

test('路径状态：三个 RFC1918 范围及边界合法且精确匹配时通过', () => {
  for (const address of ['10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.254', '192.168.0.1', '192.168.255.254']) {
    status(fixture(address, peer), 'verified', address, peer);
    status(fixture(own, address), 'verified', own, address);
  }
});

test('路径状态：TCP 以及 relay、srflx 路径明确拒绝', () => {
  for (const side of ['local', 'remote']) {
    const tcp = fixture(); tcp.get(side).protocol = 'tcp'; status(tcp, 'rejected');
    for (const type of ['relay', 'srflx']) {
      const reports = fixture(); reports.get(side).candidateType = type; status(reports, 'rejected');
    }
  }
});

test('路径状态：prflx 仅在实际选中路径双端地址精确匹配时通过', () => {
  for (const sides of [['local'], ['remote'], ['local', 'remote']]) {
    const reports = fixture(); sides.forEach(side => { reports.get(side).candidateType = 'prflx'; });
    status(reports, 'verified');
    for (const side of sides) {
      const invalid = fixture(); invalid.get(side).candidateType = 'prflx'; invalid.get(side).address = '192.168.1.5';
      status(invalid, 'rejected');
    }
  }
});

test('路径状态：prflx 统计兼容不会放宽信令候选规则', () => {
  const host = `candidate:1 1 UDP 123 ${own} 50000 typ host`;
  assert.equal(overlayCandidate(host, own), true);
  for (const candidateType of ['prflx', 'srflx', 'relay']) assert.equal(overlayCandidate(host.replace('typ host', 'typ ' + candidateType), own), false);
});

test('路径状态：没有 transport 选中项时接受唯一 nominated succeeded 回退', () => {
  const withoutTransport = fixture(); withoutTransport.delete('transport'); status(withoutTransport, 'verified');
  const withoutSelectedId = fixture(); delete withoutSelectedId.get('transport').selectedCandidatePairId; status(withoutSelectedId, 'verified');
});

test('路径状态：没有 nominated 或 nominated 尚未成功时不回退', () => {
  const noNomination = fixture(); noNomination.delete('transport'); noNomination.get('pair').nominated = false; status(noNomination, 'pending');
  const notSucceeded = fixture(); notSucceeded.delete('transport'); notSucceeded.get('pair').state = 'in-progress'; status(notSucceeded, 'pending');
});

test('路径状态：多个 nominated succeeded 回退候选有歧义时等待', () => {
  const reports = fixture(); reports.delete('transport');
  reports.set('secondPair', { ...reports.get('pair') });
  status(reports, 'pending');
});

test('路径状态：transport 指定的 pair 优先于其他 nominated 项', () => {
  const reports = fixture(); reports.get('pair').nominated = false;
  reports.set('otherPair', { ...reports.get('pair'), nominated: true, localCandidateId: 'wrongLocal' });
  reports.set('wrongLocal', { ...reports.get('local'), address: '192.168.1.5' });
  status(reports, 'verified');
  reports.get('transport').selectedCandidatePairId = 'otherPair';
  status(reports, 'rejected');
});

test('路径状态：transport 指定项暂缺或未成功不能用旧 nominated 项绕过', () => {
  const missing = fixture(); missing.get('transport').selectedCandidatePairId = 'notReportedYet'; status(missing, 'pending');
  const inProgress = fixture();
  inProgress.set('newPair', { ...inProgress.get('pair'), nominated: false, state: 'in-progress' });
  inProgress.get('transport').selectedCandidatePairId = 'newPair';
  status(inProgress, 'pending');
});

function liveFixture() {
  const pair = {
    local:{address:own,protocol:'udp',type:'host'},
    remote:{address:peer,protocol:'udp',type:'host'},
  };
  const calls = {count:0};
  const ice = {state:'connected',getSelectedCandidatePair(){calls.count++;return pair;}};
  const dtls = {state:'connected',iceTransport:ice};
  const pc = {getSenders:()=>[{transport:dtls}],getReceivers:()=>[{transport:dtls}]};
  return {pc,dtls,ice,pair,calls};
}
function liveStatus(live, reports, expected, reason) {
  const result = inspectMediaPath(live.pc,reports,own,peer);
  assert.equal(result.status,expected);
  if(reason)assert.equal(result.reason,reason);
  return result;
}

test('实时路径：统计缺失但当前选中双端私网 UDP 路径完整时通过',()=>{
  for(const reports of [new Map(),null,undefined]){
    const live=liveFixture();
    assert.equal(liveStatus(live,reports,'verified').source,'live-ice');
    assert.equal(live.calls.count,1,'same ICE transport is read once across sender and receiver');
  }
});

test('实时路径：同一 ICE transport 被多个 DTLS 包装时去重读取',()=>{
  const live=liveFixture();
  live.pc.getReceivers=()=>[{transport:{state:'connected',iceTransport:live.ice}}];
  liveStatus(live,new Map(),'verified');assert.equal(live.calls.count,1);
});

test('实时路径：实时错误地址即使统计有效也拒绝',()=>{
  for(const side of ['local','remote'])for(const address of ['10.147.20.3','192.168.1.2','8.8.8.8','127.0.0.1','::1']){
    const live=liveFixture();live.pair[side].address=address;
    liveStatus(live,fixture(),'rejected','address-mismatch');
  }
});

test('实时路径：Chromium 隐去 IP 时等待新证据，恢复真实地址后再通过',()=>{
  for(const side of ['local','remote'])for(const placeholder of ['redacted-ip.invalid','redacted-literal.invalid']){
    const live=liveFixture();live.pair[side].address=placeholder;
    liveStatus(live,fixture(),'pending','candidate-fields-missing');
    live.pair[side].address=side==='local'?own:peer;
    liveStatus(live,fixture(),'verified');
    const reports=fixture();reports.get(side).address=placeholder;delete reports.get(side).ip;
    status(reports,'pending');
    reports.get(side==='local'?'remote':'local').address='8.8.8.8';
    status(reports,'rejected');
  }
});

test('实时路径：实时 TCP 或 relay/srflx 即使统计有效也拒绝',()=>{
  for(const side of ['local','remote']){
    const tcp=liveFixture();tcp.pair[side].protocol='tcp';liveStatus(tcp,fixture(),'rejected','non-udp');
    for(const type of ['srflx','relay']){
      const live=liveFixture();live.pair[side].type=type;liveStatus(live,fixture(),'rejected','non-overlay-candidate-type');
    }
  }
});

test('实时路径：隐去的远端 prflx 地址只与当前完整统计及双端端口匹配后通过',()=>{
  const live=liveFixture(),reports=fixture();
  live.pair.local.port=reports.get('local').port=39000;
  live.pair.remote.port=reports.get('remote').port=39001;
  live.pair.remote.address='redacted-ip.invalid';live.pair.remote.type='prflx';
  liveStatus(live,reports,'verified');
  liveStatus(live,new Map(),'pending','candidate-fields-missing');
  reports.get('remote').port=39002;liveStatus(live,reports,'pending','candidate-fields-missing');
  reports.get('remote').port=39001;reports.get('remote').address='8.8.8.8';liveStatus(live,reports,'rejected','address-mismatch');
  reports.get('remote').address=peer;delete live.pair.remote.address;liveStatus(live,reports,'pending','candidate-fields-missing');
});

test('实时路径：统计明确违规时实时有效也不能覆盖拒绝',()=>{
  for(const side of ['local','remote']){
    const wrong=fixture();wrong.get(side).address='8.8.8.8';
    assert.equal(liveStatus(liveFixture(),wrong,'rejected','address-mismatch').source,'stats');
    const tcp=fixture();tcp.get(side).protocol='tcp';liveStatus(liveFixture(),tcp,'rejected','non-udp');
    const relay=fixture();relay.get(side).candidateType='relay';liveStatus(liveFixture(),relay,'rejected','non-overlay-candidate-type');
  }
});

test('实时路径：统计一端字段暂缺不能掩盖另一端的明确冲突',()=>{
  for(const side of ['local','remote']){
    const other=side==='local'?'remote':'local';
    for(const key of ['address','protocol','candidateType']){
      const reports=fixture();delete reports.get(side)[key];reports.get(other).address='8.8.8.8';
      liveStatus(liveFixture(),reports,'rejected','address-mismatch');
    }
    const missing=fixture();missing.delete(side);missing.get(other).protocol='tcp';
    liveStatus(liveFixture(),missing,'rejected','non-udp');
    const malformed=fixture();malformed.get(side).protocol={};
    liveStatus(liveFixture(),malformed,'rejected','non-udp');
  }
});

test('实时路径：全部已发现 DTLS 和 ICE transport 都必须就绪',()=>{
  for(const state of ['new','connecting','closed','failed',undefined]){
    const live=liveFixture();live.dtls.state=state;liveStatus(live,fixture(),'pending','live-transport-not-ready');
  }
  for(const state of ['new','checking','disconnected','closed','failed',undefined]){
    const live=liveFixture();live.ice.state=state;liveStatus(live,fixture(),'pending','live-transport-not-ready');
  }
  const completed=liveFixture();completed.ice.state='completed';liveStatus(completed,new Map(),'verified');
  const missing=liveFixture();delete missing.dtls.iceTransport;liveStatus(missing,fixture(),'pending','live-transport-missing');
});

test('实时路径：读取不到选中路径或字段时不能用旧统计放行',()=>{
  for(const pair of [null,undefined,{}, {local:{}},{remote:{}}]){
    const live=liveFixture();live.ice.getSelectedCandidatePair=()=>pair;liveStatus(live,fixture(),'pending','live-pair-not-ready');
  }
  for(const side of ['local','remote'])for(const key of ['address','protocol','type']){
    const live=liveFixture();delete live.pair[side][key];liveStatus(live,fixture(),'pending','candidate-fields-missing');
  }
});

test('实时路径：异常读取不使用旧统计或旧通过结果',()=>{
  const live=liveFixture();liveStatus(live,fixture(),'verified');
  live.ice.getSelectedCandidatePair=()=>{throw new Error('temporary API failure');};
  liveStatus(live,fixture(),'pending','live-api-unavailable');
  live.pc.getSenders=()=>{throw new Error('endpoint access failed');};
  liveStatus(live,fixture(),'pending','live-api-unavailable');
});

test('实时路径：不支持实时 API 时完整回退原统计判定',()=>{
  for(const pc of [{},{getSenders:()=>[],getReceivers:()=>[]},{getSenders:()=>[{transport:null}]}]){
    const live={pc};assert.equal(liveStatus(live,fixture(),'verified').source,'stats');
    liveStatus(live,new Map(),'pending');
  }
  const live=liveFixture();delete live.ice.getSelectedCandidatePair;
  assert.equal(liveStatus(live,fixture(),'verified').source,'stats');liveStatus(live,new Map(),'pending');
});

test('实时路径：多个不同 transport 要逐个验证，任何明确冲突拒绝',()=>{
  const live=liveFixture(),second=liveFixture();
  live.pc.getReceivers=()=>[{transport:second.dtls}];
  liveStatus(live,new Map(),'verified');assert.equal(live.calls.count,1);assert.equal(second.calls.count,1);
  second.pair.remote.address='8.8.8.8';liveStatus(live,fixture(),'rejected','address-mismatch');
  second.pair.remote.address=peer;second.ice.getSelectedCandidatePair=()=>null;
  liveStatus(live,fixture(),'pending','live-pair-not-ready');
});

test('实时路径：多个 transport 部分不支持实时 API 时不能遗漏检查',()=>{
  const live=liveFixture(),second=liveFixture();delete second.ice.getSelectedCandidatePair;
  live.pc.getReceivers=()=>[{transport:second.dtls}];
  liveStatus(live,fixture(),'pending','live-api-incomplete');
});

test('实时路径：精确地址 UDP prflx 兼容不放宽信令规则',()=>{
  const live=liveFixture();
  live.pair.local.type='prflx';live.pair.remote.type='prflx';live.pair.remote.protocol='UDP';
  liveStatus(live,new Map(),'verified');
  assert.equal(overlayCandidate(`candidate:1 1 UDP 123 ${own} 50000 typ prflx`,own),false);
});

test('实时路径：配置地址仍必须合法且精确，不能由实时数据绕过',()=>{
  for(const address of ['8.8.8.8','100.64.0.1','10.1.1.999','10.01.1.1']){
    const live=liveFixture();live.pair.local.address=address;
    assert.equal(inspectMediaPath(live.pc,new Map(),address,peer).status,'rejected');
  }
});
