// Shared by the trusted signaling server and renderer. No DNS, STUN, TURN or
// LAN/public candidates are admitted to an overlay-only room.
export function overlayCandidate(candidate, address) {
  if (candidate === null) return true;
  const line = typeof candidate === 'string' ? candidate : candidate?.candidate;
  if (line === '') return true;
  if (typeof line !== 'string' || line.length > 4096) return false;
  const parts = line.trim().replace(/^a=/, '').split(/\s+/);
  return parts.length >= 8 && /^candidate:[A-Za-z0-9+/_.-]+$/.test(parts[0]) &&
    ['1','2'].includes(parts[1]) && parts[2].toLowerCase() === 'udp' && parts[4] === address &&
    /^\d+$/.test(parts[5]) && Number(parts[5]) > 0 && Number(parts[5]) <= 65535 && parts[6] === 'typ' && parts[7] === 'host';
}
export function overlayDescription(description, address) {
  if (!description || !['offer','answer'].includes(description.type) || typeof description.sdp !== 'string' || description.sdp.length > 60000) throw new Error('会话描述无效');
  const lines = description.sdp.split(/\r?\n/).filter(line => {
    if (line.startsWith('a=candidate:')) return overlayCandidate(line, address);
    return !line.startsWith('a=remote-candidates:');
  }).map(line => line.startsWith('c=IN ') ? 'c=IN IP4 0.0.0.0' : line.startsWith('a=rtcp:') ? 'a=rtcp:9 IN IP4 0.0.0.0' : line);
  return { type: description.type, sdp: lines.join('\r\n') };
}
function privateAddress(address) {
  if (typeof address !== 'string') return false;
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some(p => !/^(0|[1-9][0-9]{0,2})$/.test(p) || Number(p) > 255)) return false;
  const [a,b] = parts.map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
function candidateAddress(candidate) {
  const address=candidate.address || candidate.ip;
  // Chromium uses these placeholders while withholding a candidate's IP.
  // They are missing evidence, not an observed conflicting network address.
  return ['redacted-ip.invalid','redacted-literal.invalid'].includes(address) ? null : address;
}
function selectedPair(reports) {
  const selected = new Set(), nominated = [];
  reports.forEach(item => {
    if (item.type === 'transport' && item.selectedCandidatePairId) selected.add(item.selectedCandidatePairId);
    if (item.type === 'candidate-pair' && item.nominated && item.state === 'succeeded') nominated.push(item);
  });
  const pair = selected.size ? reports.get([...selected][0]) : nominated.length === 1 ? nominated[0] : null;
  return {pair,multiple:selected.size>1};
}
export function inspectPair(reports, ownAddress, peerAddress) {
  if (!privateAddress(ownAddress) || !privateAddress(peerAddress)) return { status:'rejected', reason:'invalid-overlay-address' };
  const {pair,multiple}=selectedPair(reports);
  if (multiple) return {status:'pending',reason:'multiple-selected-pairs'};
  if (!pair || pair.state !== 'succeeded') return {status:'pending',reason:'pair-not-ready'};
  const local=reports.get(pair.localCandidateId), remote=reports.get(pair.remoteCandidateId);
  let pending = !local || !remote ? {status:'pending',reason:'candidate-stats-missing'} : null;
  for (const [candidate,address] of [[local,ownAddress],[remote,peerAddress]]) {
    if (!candidate) continue;
    const actual=candidateAddress(candidate);
    if (actual && actual !== address) return {status:'rejected',reason:'address-mismatch'};
    if (candidate.protocol && (typeof candidate.protocol !== 'string' || candidate.protocol.toLowerCase() !== 'udp')) return {status:'rejected',reason:'non-udp'};
    // Peer-reflexive is an ICE observation, not a permitted signaling candidate.
    // It is safe here only with the exact authenticated overlay address and UDP.
    if (candidate.candidateType && !['host','prflx'].includes(candidate.candidateType)) return {status:'rejected',reason:'non-overlay-candidate-type'};
    if (!actual || !candidate.protocol || !candidate.candidateType) pending ||= {status:'pending',reason:'candidate-fields-missing'};
  }
  if (pending) return pending;
  return {status:'verified',reason:'overlay-udp'};
}
export function verifiedPair(reports, ownAddress, peerAddress) {
  return inspectPair(reports,ownAddress,peerAddress).status === 'verified';
}

// Read the current ICE transport directly when supported. This is fresh evidence,
// never a cached verification: missing statistics alone need not interrupt an
// unchanged, currently selected overlay path. Explicit conflicts from either
// source still fail closed. The renderer must also gate on PC connection state.
export function inspectMediaPath(pc, reports, ownAddress, peerAddress) {
  let stats;
  try { stats = inspectPair(reports || new Map(), ownAddress, peerAddress); }
  catch { stats = {status:'pending',reason:'stats-unavailable'}; }
  if (stats.status === 'rejected') return {...stats,source:'stats'};

  try {
    const dtlsTransports = new Set();
    for (const method of ['getSenders','getReceivers']) {
      if (typeof pc?.[method] !== 'function') continue;
      for (const endpoint of pc[method]()) if (endpoint?.transport) dtlsTransports.add(endpoint.transport);
    }
    if (!dtlsTransports.size) return {...stats,source:'stats'};

    const iceTransports = new Set();
    let pending = null;
    for (const dtls of dtlsTransports) {
      if (dtls.state !== 'connected') pending ||= {status:'pending',reason:'live-transport-not-ready'};
      const ice = dtls.iceTransport;
      if (!ice) pending ||= {status:'pending',reason:'live-transport-missing'};
      else iceTransports.add(ice);
    }

    let usedLive = false, needsStats = false;
    for (const ice of iceTransports) {
      if (!['connected','completed'].includes(ice.state)) pending ||= {status:'pending',reason:'live-transport-not-ready'};
      if (typeof ice.getSelectedCandidatePair !== 'function') { needsStats = true; continue; }
      usedLive = true;
      const pair = ice.getSelectedCandidatePair();
      if (!pair?.local || !pair?.remote) { pending ||= {status:'pending',reason:'live-pair-not-ready'}; continue; }
      // Chromium always hides the live prflx remote IP, including after it was
      // signaled. Current selected-pair stats may expose the authenticated IP.
      // Use those only when BOTH live UDP ports identify that same selected pair.
      const reported=stats.status==='verified'?selectedPair(reports).pair:null;
      const samePorts=reported&&[[pair.local,reports.get(reported.localCandidateId)],[pair.remote,reports.get(reported.remoteCandidateId)]].every(([live,record])=>Number.isInteger(live.port)&&live.port>0&&live.port<=65535&&live.port===record?.port);
      // RTCIceCandidate exposes `type`, while RTCIceCandidateStats uses
      // `candidateType`. Normalize only this API difference, not addresses.
      for (const [candidate,address] of [[pair.local,ownAddress],[pair.remote,peerAddress]]) {
        const actual = candidateAddress(candidate);
        const protocol = candidate.protocol;
        const candidateType = candidate.type;
        const hiddenRemote=candidate===pair.remote&&candidateType==='prflx'&&!actual&&['redacted-ip.invalid','redacted-literal.invalid'].includes(candidate.address||candidate.ip)&&samePorts;
        if (actual && actual !== address) return {status:'rejected',reason:'address-mismatch',source:'live-ice'};
        if (protocol && (typeof protocol !== 'string' || protocol.toLowerCase() !== 'udp')) return {status:'rejected',reason:'non-udp',source:'live-ice'};
        if (candidateType && !['host','prflx'].includes(candidateType)) return {status:'rejected',reason:'non-overlay-candidate-type',source:'live-ice'};
        if ((!actual&&!hiddenRemote) || !protocol || !candidateType) pending ||= {status:'pending',reason:'candidate-fields-missing'};
      }
    }
    if (pending) return {...pending,source:'live-ice'};
    if (!usedLive) return {...stats,source:'stats'};
    if (needsStats) return {status:'pending',reason:'live-api-incomplete',source:'live-ice'};
    return {status:'verified',reason:'overlay-udp',source:'live-ice'};
  } catch {
    // A supported live API that cannot be read must not be bypassed using a
    // potentially older stats snapshot. Unsupported APIs use stats above.
    return {status:'pending',reason:'live-api-unavailable',source:'live-ice'};
  }
}
