import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp, readConfig } from '../server.mjs';

const output = path.resolve('artifacts/media-quality-0.3.5');
const probeOnly = process.env.MEDIA_FIXED_PROBE === '1';
const testCodec = process.env.MEDIA_TEST_CODEC || '';
const runTag = new Date().toISOString().replace(/[:.]/g, '-');
await mkdir(output, { recursive: true });
const address = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => /zerotier/i.test(name) ? list.filter(a => a.family === 'IPv4' && !a.internal).map(a => a.address) : [])[0];
assert.ok(address, 'Requires an existing local ZeroTier IPv4 adapter');
const config = readConfig({ PORT: '0', ACCOUNT_DATA_DIR: ':memory:' });
const server = createApp(config);
const base = 'http://127.0.0.1:' + await server.listen();
const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
const contexts = [], checks = [], errors = [];
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const result = { date: new Date().toISOString(), checks, errors, passed: false, environment: 'Single Windows computer, existing ZeroTier IPv4 adapter, Edge, two isolated browser contexts. Loopback signaling server with explicitly mocked enrollment/identity messages; real overlay-only RTCPeerConnection media. Synthetic full-frame moving 1920x1080 canvas and oscillator only. No user screen/microphone capture.', limits: 'Not two physical computers, cross-network, clean Windows installation, or actual system/microphone audio validation. A 600kbps sender encoding cap is not a network bandwidth/latency/loss emulator and does not reproduce 379ms RTT or ZeroTier relay conditions. getStats missing/prflx/bad-address and live-pair missing scenarios are injected test cases.' };

result.testOverrides = { codecPreference: testCodec || null, fixedProbeOnly: probeOnly, codecOverrideIsProduction: false };

function fixture({ address, testCodec }) {
  window.__pcs = []; window.__captures = []; window.__statsMode = 'normal'; window.__sentCandidateClasses = [];
  window.__videoCapabilities = RTCRtpSender.getCapabilities('video');
  window.__stageObjectResets = 0; window.__videoDetaches = 0;
  const srcObject = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { ...srcObject, set(value) {
    if (this.id === 'stage-video' && srcObject.get.call(this) && srcObject.get.call(this) !== value) window.__stageObjectResets++;
    return srcObject.set.call(this, value);
  } });
  const replaceTrack = RTCRtpSender.prototype.replaceTrack;
  RTCRtpSender.prototype.replaceTrack = function(track) {
    if (this.track?.kind === 'video' && track === null) window.__videoDetaches++;
    return replaceTrack.call(this, track);
  };
  const getLivePair = globalThis.RTCIceTransport?.prototype.getSelectedCandidatePair;
  window.__livePairApi = typeof getLivePair === 'function';
  if (getLivePair) RTCIceTransport.prototype.getSelectedCandidatePair = function(...args) {
    if (window.__statsMode === 'missing-both') return null;
    return getLivePair.apply(this, args);
  };
  const NativePC = RTCPeerConnection;
  window.RTCPeerConnection = class extends NativePC {
    constructor(...args) { super(...args); window.__pcs.push(this); }
    addTransceiver(trackOrKind, options) {
      const transceiver = super.addTransceiver(trackOrKind, options);
      if ((trackOrKind === 'video' || trackOrKind?.kind === 'video') && testCodec) {
        const codecs = RTCRtpSender.getCapabilities('video').codecs;
        const preferred = codecs.filter(codec => codec.mimeType.toLowerCase() === 'video/' + testCodec.toLowerCase());
        if (!preferred.length) throw new Error('Requested test codec is unavailable: ' + testCodec);
        transceiver.setCodecPreferences([...preferred, ...codecs.filter(codec => !preferred.includes(codec))]);
      }
      return transceiver;
    }
    async getStats(...args) {
      const native = await super.getStats(...args);
      const reports = new Map([...native].map(([id, item]) => [id, { ...item }]));
      let selected;
      for (const item of reports.values()) if (item.type === 'transport' && item.selectedCandidatePairId) selected = reports.get(item.selectedCandidatePairId);
      if (['missing', 'missing-both'].includes(window.__statsMode)) for (const [id, item] of reports) if (item.type === 'candidate-pair') reports.delete(id);
      if (selected && window.__statsMode === 'remote-prflx') { const remote = reports.get(selected.remoteCandidateId); if (remote) remote.candidateType = 'prflx'; }
      if (selected && window.__statsMode === 'bad-address') { const remote = reports.get(selected.remoteCandidateId); if (remote) remote.address = '8.8.8.8'; }
      return reports;
    }
  };
  const NativeWS = WebSocket;
  window.WebSocket = class extends NativeWS {
    constructor(...args) {
      super(...args); let handler;
      Object.defineProperty(this, 'onmessage', { configurable: true, get: () => handler, set: value => { handler = value; } });
      this.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.type === 'joined') { message.overlay = true; message.address = address; message.peers.forEach(peer => { peer.address = address; }); }
        if (message.type === 'peer-joined') message.peer.address = address;
        handler?.call(this, new MessageEvent('message', { data: JSON.stringify(message) }));
      });
    }
    send(data) {
      const message = JSON.parse(data);
      const candidate = message.payload?.candidate?.candidate;
      if (candidate) { const parts = candidate.split(/\s+/); window.__sentCandidateClasses.push({ overlay: parts[4] === address, protocol: parts[2], type: parts[7] }); }
      return super.send(data);
    }
  };
  function audio() {
    const context = new AudioContext(), source = context.createOscillator(), gain = context.createGain(), destination = context.createMediaStreamDestination();
    gain.gain.value = 0.02; source.connect(gain); gain.connect(destination); source.start(); context.resume();
    const track = destination.stream.getAudioTracks()[0], stop = track.stop.bind(track);
    track.stop = () => { source.stop(); context.close(); stop(); }; return track;
  }
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => new MediaStream([audio()]) });
  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { value: async () => {
    const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
    const ctx = canvas.getContext('2d'); let frame = 0;
    window.__paintedFrames = 0; window.__paintMs = 0;
    const draw = () => {
      const started = performance.now();
      ctx.fillStyle = '#0b111a'; ctx.fillRect(0, 0, 1920, 1080);
      const offset = (frame++ * 13) % 240;
      for (let y = -100; y < 1180; y += 120) for (let x = -240; x < 2160; x += 240) {
        ctx.fillStyle = (x / 240 + y / 120) % 2 ? '#1d645c' : '#254779';
        ctx.fillRect(x + offset, y + offset / 3, 210, 95);
      }
      ctx.fillStyle = '#d9f5e8'; ctx.font = '18px monospace';
      for (let y = 40; y < 1040; y += 72) ctx.fillText('1920 x 1080 full-frame motion | ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789 | frame ' + frame, 32 + offset / 2, y);
      ctx.fillStyle = '#48d9ac'; ctx.fillRect((frame * 19) % 1800, 980, 120, 60);
      window.__paintedFrames++; window.__paintMs += performance.now() - started;
    };
    draw(); const timer = setInterval(draw, 1000 / 60), stream = canvas.captureStream(60); stream.addTrack(audio());
    const track = stream.getVideoTracks()[0], stop = track.stop.bind(track); track.stop = () => { clearInterval(timer); stop(); };
    window.__captures.push(stream); return stream;
  } });
}

async function makePage(name, room) {
  const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1550, height: 1050 } }); contexts.push(context);
  await context.addInitScript(fixture, { address, testCodec });
  const page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', e => errors.push(e.stack || e.message));
  page.on('requestfailed', request => errors.push('requestfailed ' + request.url() + ': ' + request.failure()?.errorText));
  await page.goto(base + (room ? '/#room=' + room : '/'));
  await page.waitForFunction(() => document.querySelector('#network-note-title').textContent !== '正在检查连接环境');
  if (room) { await page.locator('#join-name').fill(name); await page.locator('#join-password').fill('quality-test-password'); await page.locator('#join-btn').click(); await page.locator('#room-view').waitFor({ state: 'visible' }); }
  return page;
}
async function sample(page) {
  return page.evaluate(async () => {
    const pcs = window.__pcs.filter(pc => pc.connectionState !== 'closed'), stats = pcs.length ? [...(await pcs[0].getStats()).values()] : [];
    const video = document.querySelector('#stage-video');
    return { activePeers: pcs.length, closedPeers: window.__pcs.filter(pc => pc.connectionState === 'closed').length, members: document.querySelectorAll('#members-list li').length,
      videoHidden: video.hidden, videoAttached: Boolean(video.srcObject), width: video.videoWidth, height: video.videoHeight,
      frames: stats.filter(s => s.type === 'inbound-rtp' && s.kind === 'video').reduce((n, s) => n + (s.framesDecoded || 0), 0),
      audioBytes: stats.filter(s => s.type === 'inbound-rtp' && s.kind === 'audio').reduce((n, s) => n + (s.bytesReceived || 0), 0),
      outbound: stats.filter(s => s.type === 'outbound-rtp' && s.kind === 'video').map(s => ({ width: s.frameWidth, height: s.frameHeight, fps: s.framesPerSecond, bytes: s.bytesSent, limitation: s.qualityLimitationReason })),
      senderTracks: pcs.map(pc => pc.getSenders().map(s => s.track?.kind || null)),
      bitrate: document.querySelector('#metric-bitrate').textContent, diagnostics: document.querySelector('#connection-diagnostics').textContent, status: document.querySelector('#status-message').textContent,
      stageObjectResets: window.__stageObjectResets, videoDetaches: window.__videoDetaches, livePairApi: window.__livePairApi,
      videoCapabilities: window.__videoCapabilities,
      sentCandidates: window.__sentCandidateClasses };
  });
}
async function motionCounters(page) {
  return page.evaluate(async () => {
    const pc = window.__pcs.find(pc => pc.connectionState !== 'closed'), reports = pc ? [...(await pc.getStats()).values()] : [];
    const outgoing = reports.filter(s => s.type === 'outbound-rtp' && s.kind === 'video'), incoming = reports.filter(s => s.type === 'inbound-rtp' && s.kind === 'video');
    const sum = (items, key) => items.reduce((n, s) => n + (s[key] || 0), 0);
    const pairs = reports.filter(s => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded');
    return { time: performance.now(), framesEncoded: sum(outgoing, 'framesEncoded'), framesDecoded: sum(incoming, 'framesDecoded'),
      bytesSent: sum(outgoing, 'bytesSent'), bytesReceived: sum(incoming, 'bytesReceived'), packetsLost: sum(incoming, 'packetsLost'), packetsReceived: sum(incoming, 'packetsReceived'),
      freezeCount: sum(incoming, 'freezeCount'), totalFreezesDuration: sum(incoming, 'totalFreezesDuration'), jitterBufferDelay: sum(incoming, 'jitterBufferDelay'), jitterBufferEmittedCount: sum(incoming, 'jitterBufferEmittedCount'),
      outgoing: outgoing.map(s => ({ width: s.frameWidth, height: s.frameHeight, fps: s.framesPerSecond, limitation: s.qualityLimitationReason,
        framesEncoded: s.framesEncoded, framesSent: s.framesSent, totalEncodeTime: s.totalEncodeTime, encoderImplementation: s.encoderImplementation, powerEfficientEncoder: s.powerEfficientEncoder,
        qualityLimitationDurations: s.qualityLimitationDurations, qualityLimitationResolutionChanges: s.qualityLimitationResolutionChanges,
        codecId: s.codecId, mimeType: reports.find(codec => codec.id === s.codecId)?.mimeType })),
      mediaSources: reports.filter(s => s.type === 'media-source' && s.kind === 'video').map(s => ({ width: s.width, height: s.height, fps: s.framesPerSecond, frames: s.frames })),
      paintedFrames: window.__paintedFrames || 0, totalPaintMs: window.__paintMs || 0,
      incoming: incoming.map(s => ({ width: s.frameWidth, height: s.frameHeight, fps: s.framesPerSecond, jitter: s.jitter })),
      pairs: pairs.map(s => ({ rttMs: (s.currentRoundTripTime || 0) * 1000, availableOutgoingBitrate: s.availableOutgoingBitrate })),
      stageHidden: document.querySelector('#stage-video').hidden, stageObjectResets: window.__stageObjectResets, videoDetaches: window.__videoDetaches };
  });
}
async function measureMotion(host, viewer, seconds = 10) {
  const samples = [ { host: await motionCounters(host), viewer: await motionCounters(viewer) } ];
  for (let i = 0; i < seconds; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    samples.push({ host: await motionCounters(host), viewer: await motionCounters(viewer) });
  }
  const first = samples[0], last = samples.at(-1);
  const txSeconds = (last.host.time - first.host.time) / 1000, rxSeconds = (last.viewer.time - first.viewer.time) / 1000;
  return { samples, seconds: rxSeconds, encodedFps: (last.host.framesEncoded - first.host.framesEncoded) / txSeconds, decodedFps: (last.viewer.framesDecoded - first.viewer.framesDecoded) / rxSeconds,
    sourceFps: (last.host.mediaSources.reduce((n,s) => n + (s.frames || 0), 0) - first.host.mediaSources.reduce((n,s) => n + (s.frames || 0), 0)) / txSeconds,
    paintedFps: (last.host.paintedFrames - first.host.paintedFrames) / txSeconds, meanPaintMs: (last.host.totalPaintMs - first.host.totalPaintMs) / Math.max(1, last.host.paintedFrames - first.host.paintedFrames),
    sentMbps: (last.host.bytesSent - first.host.bytesSent) * 8 / txSeconds / 1e6, receivedMbps: (last.viewer.bytesReceived - first.viewer.bytesReceived) * 8 / rxSeconds / 1e6,
    freezes: last.viewer.freezeCount - first.viewer.freezeCount, frozenSeconds: last.viewer.totalFreezesDuration - first.viewer.totalFreezesDuration,
    packetsLost: last.viewer.packetsLost - first.viewer.packetsLost, packetsReceived: last.viewer.packetsReceived - first.viewer.packetsReceived,
    meanJitterBufferMs: (last.viewer.jitterBufferDelay - first.viewer.jitterBufferDelay) * 1000 / Math.max(1, last.viewer.jitterBufferEmittedCount - first.viewer.jitterBufferEmittedCount) };
}
async function warmFixed60(host, viewer) {
  const samples = [];
  await new Promise(resolve => setTimeout(resolve, 5000));
  let consecutiveReady = 0, previous = { host: await motionCounters(host), viewer: await motionCounters(viewer) };
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const current = { host: await motionCounters(host), viewer: await motionCounters(viewer) };
    const txSeconds = (current.host.time - previous.host.time) / 1000, rxSeconds = (current.viewer.time - previous.viewer.time) / 1000;
    const encodedFps = (current.host.framesEncoded - previous.host.framesEncoded) / txSeconds, decodedFps = (current.viewer.framesDecoded - previous.viewer.framesDecoded) / rxSeconds;
    const sourceFps = (current.host.mediaSources.reduce((n,s) => n + (s.frames || 0), 0) - previous.host.mediaSources.reduce((n,s) => n + (s.frames || 0), 0)) / txSeconds;
    const fullSize = current.host.outgoing.some(v => v.width === 1920 && v.height === 1080) && current.viewer.incoming.some(v => v.width === 1920 && v.height === 1080);
    const ready = fullSize && sourceFps >= 55 && encodedFps >= 55 && decodedFps >= 55;
    consecutiveReady = ready ? consecutiveReady + 1 : 0;
    samples.push({ ...current, sourceFps, encodedFps, decodedFps, fullSize, ready }); previous = current;
    if (consecutiveReady >= 3) return { ready: true, additionalWarmupSeconds: samples.length, samples };
  }
  return { ready: false, additionalWarmupSeconds: samples.length, samples };
}
let host, viewer;
async function runChecks() {
try {
  host = await makePage('quality-host');
  await host.locator('#create-name').fill('quality-host'); await host.locator('#create-password').fill('quality-test-password'); await host.locator('#create-btn').click();
  await host.locator('#room-view').waitFor({ state: 'visible' });
  const room = await host.locator('#room-code').textContent(); viewer = await makePage('quality-viewer', room);
  await Promise.all([host, viewer].map(page => page.waitForFunction(() => document.querySelector('#connection-diagnostics').textContent.includes('私有网卡（已验证）'))));
  assert.equal(await host.locator('#quality-select').inputValue(), '1080p60');
  assert.equal(await host.locator('#sharing-priority').inputValue(), 'fixed'); await host.locator('#share-btn').click();
  await viewer.waitForFunction(async () => { const v = document.querySelector('#stage-video'); if (v.hidden || v.videoWidth < 320 || v.videoHeight < 180) return false; for (const pc of window.__pcs) for (const stat of (await pc.getStats()).values()) if (stat.type === 'inbound-rtp' && stat.kind === 'video' && stat.framesDecoded >= 10) return true; return false; });
  const quality = await host.evaluate(() => { const sender = window.__pcs[0].getSenders().find(s => s.track?.kind === 'video'); return { hint: sender.track.contentHint, parameters: sender.getParameters() }; });
  assert.equal(quality.hint, 'motion'); assert.equal(quality.parameters.degradationPreference, 'maintain-resolution');
  assert.equal(quality.parameters.encodings[0].maxBitrate, 8000000); assert.equal(quality.parameters.encodings[0].maxFramerate, 60);
  assert.equal(quality.parameters.encodings[0].scaleResolutionDownBy, 1);
  await viewer.waitForFunction(() => { const d = document.querySelector('#connection-diagnostics').textContent; const match = d.match(/接收 ([0-9.]+) Mbps/); return match && Number(match[1]) > 0 && /发送/.test(d); });
  result.quality = quality; result.initial = { host: await sample(host), viewer: await sample(viewer) };
  assert.ok(result.initial.host.outbound.some(s => s.width >= 320 && s.height >= 180));
  assert.ok(result.initial.viewer.audioBytes > 0);
  for (const state of Object.values(result.initial)) assert.ok(state.sentCandidates.every(c => c.overlay && c.protocol.toLowerCase() === 'udp' && c.type === 'host'));
  pass('Default fixed 1080p60 requests motion content at full scale and 8Mbps maximum, reports actual encode/decode and receive rate, and exchanges only overlay UDP host candidates');

  result.fixed60Warmup = await warmFixed60(host, viewer);
  result.fixed60 = await measureMotion(host, viewer, 10);
  result.fixed60.target = { width: 1920, height: 1080, minimumSustainedFps: 50, seconds: 10 };
  result.fixed60.meetsTarget = result.fixed60.seconds >= 8 && result.fixed60.encodedFps >= 50 && result.fixed60.decodedFps >= 50 && result.fixed60.samples.every(s =>
    s.host.outgoing.some(v => v.width === 1920 && v.height === 1080) && s.viewer.incoming.some(v => v.width === 1920 && v.height === 1080) && !s.viewer.stageHidden);
  await viewer.screenshot({ path: path.join(output, '1080p-viewer.png'), fullPage: true });
  console.log((result.fixed60.meetsTarget ? 'PASS ' : 'TARGET NOT MET ') + 'Actual fixed 1920x1080: encoded ' + result.fixed60.encodedFps.toFixed(2) + 'fps / decoded ' + result.fixed60.decodedFps.toFixed(2) + 'fps over ' + result.fixed60.seconds.toFixed(2) + 's');
  if (result.fixed60.meetsTarget) pass('Fixed 1080p60 sustains actual 1920x1080 encoded/decoded frames at >=50fps over >=8 seconds after warmup');
  if (probeOnly) {
    result.scope = 'Focused fixed 1080p60 probe only; remaining regression checks were not run in this invocation';
    assert.equal(result.fixed60.meetsTarget, true, 'Focused 1080p60 probe did not sustain the target; see actual source/encoding/network evidence');
    result.passed = true; return;
  }

  await host.locator('#quality-select').selectOption('1080p30');
  await host.locator('#sharing-priority').selectOption('motion');
  await host.waitForFunction(() => { const s = window.__pcs[0].getSenders().find(s => s.track?.kind === 'video'); return s?.track.contentHint === 'motion' && s.getParameters().degradationPreference === 'maintain-framerate' && s.getParameters().encodings[0].maxFramerate === 30; });

  result.normalMotion = await measureMotion(host, viewer, 10);
  assert.ok(result.normalMotion.seconds >= 8); assert.ok(result.normalMotion.encodedFps >= 18); assert.ok(result.normalMotion.decodedFps >= 18);
  assert.ok(result.normalMotion.samples.every(s => !s.viewer.stageHidden));
  pass('Continuous full-frame movement has measured encoded/decoded FPS over a >=8 second window, without hiding playback');

  await host.evaluate(async () => {
    const sender = window.__pcs[0].getSenders().find(s => s.track?.kind === 'video');
    const parameters = sender.getParameters(); parameters.encodings[0].maxBitrate = 600000; await sender.setParameters(parameters);
  });
  await new Promise(resolve => setTimeout(resolve, 3500));
  result.cappedMotion = await measureMotion(host, viewer, 10);
  result.cappedMotion.meetsDiagnosticFloor = result.cappedMotion.seconds >= 8 && result.cappedMotion.encodedFps >= 12 && result.cappedMotion.decodedFps >= 12 && result.cappedMotion.freezes === 0;
  result.cappedMotion.interpretation = 'A 600kbps sender encoding cap on a same-computer Edge loopback is a synthetic encoder constraint, not a bandwidth/latency/loss network emulator. Its measured rate, freeze counters and FPS are recorded, but do not by themselves predict real ZeroTier cross-network playback.';
  assert.ok(result.cappedMotion.seconds >= 8);
  assert.ok(result.cappedMotion.samples.length >= 9, '600kbps window should retain one-second measurements');
  await viewer.screenshot({ path: path.join(output, '600kbps-motion-viewer.png'), fullPage: true });
  console.log('600kbps diagnostic: encoded ' + result.cappedMotion.encodedFps.toFixed(2) + 'fps / decoded ' + result.cappedMotion.decodedFps.toFixed(2) + 'fps, ' + result.cappedMotion.freezes + ' freezes / ' + result.cappedMotion.frozenSeconds.toFixed(2) + 's frozen, ' + result.cappedMotion.sentMbps.toFixed(3) + 'Mbps');
  pass('600kbps local sender cap records measured frame rate, actual bitrate and freezes without treating it as a network emulation');

  await host.locator('#sharing-priority').selectOption('detail');
  await host.waitForFunction(() => { const s = window.__pcs[0].getSenders().find(s => s.track?.kind === 'video'); return s?.track.contentHint === 'detail' && s.getParameters().degradationPreference === 'maintain-resolution'; });
  assert.equal(await host.evaluate(() => window.__pcs[0].getSenders().find(s => s.track?.kind === 'video').getParameters().encodings[0].scaleResolutionDownBy), 1);
  await host.locator('#sharing-priority').selectOption('motion');
  await host.waitForFunction(() => { const s = window.__pcs[0].getSenders().find(s => s.track?.kind === 'video'); return s?.track.contentHint === 'motion' && s.getParameters().degradationPreference === 'maintain-framerate' && s.getParameters().encodings[0].maxBitrate === 5000000; });
  pass('Sharing priority switches between detail/maintain-resolution and motion/maintain-framerate during an active share');

  const beforeMissing = { host: await sample(host), viewer: await sample(viewer) };
  assert.equal(beforeMissing.host.livePairApi, true, 'Regression browser must support the live ICE selected-pair API');
  await Promise.all([host, viewer].map(page => page.evaluate(() => { window.__statsMode = 'missing'; })));
  await new Promise(resolve => setTimeout(resolve, 3500));
  result.statsMissingLiveVerified = { host: await sample(host), viewer: await sample(viewer) };
  assert.ok(result.statsMissingLiveVerified.host.senderTracks[0].includes('video'));
  assert.equal(result.statsMissingLiveVerified.host.videoDetaches, beforeMissing.host.videoDetaches);
  assert.equal(result.statsMissingLiveVerified.viewer.stageObjectResets, beforeMissing.viewer.stageObjectResets);
  assert.equal(result.statsMissingLiveVerified.viewer.videoHidden, false);
  assert.ok(result.statsMissingLiveVerified.viewer.frames > beforeMissing.viewer.frames + 10);
  pass('Missing statistics with a currently verified live overlay ICE pair do not detach video or reset playback, and new frames continue decoding');
  result.repeatedStatsGaps = [];
  for (let i = 0; i < 3; i++) {
    await Promise.all([host, viewer].map(page => page.evaluate(() => { window.__statsMode = 'normal'; })));
    await new Promise(resolve => setTimeout(resolve, 500));
    await Promise.all([host, viewer].map(page => page.evaluate(() => { window.__statsMode = 'missing'; })));
    await new Promise(resolve => setTimeout(resolve, 1200));
    const state = { host: await sample(host), viewer: await sample(viewer) };
    result.repeatedStatsGaps.push(state);
    assert.equal(state.host.videoDetaches, beforeMissing.host.videoDetaches);
    assert.equal(state.viewer.stageObjectResets, beforeMissing.viewer.stageObjectResets);
    assert.equal(state.viewer.videoHidden, false);
    assert.equal(state.viewer.activePeers, 1);
  }
  assert.ok(result.repeatedStatsGaps.at(-1).viewer.frames > result.statsMissingLiveVerified.viewer.frames + 10);
  pass('Repeated statistics gaps keep the currently verified live path playing without a media detachment or player reset');

  await viewer.evaluate(() => { window.__beforePendingStream = document.querySelector('#stage-video').srcObject; });
  await Promise.all([host, viewer].map(page => page.evaluate(() => { window.__statsMode = 'missing-both'; })));
  await host.waitForFunction(() => window.__pcs[0].getSenders().every(s => s.track === null));
  await viewer.waitForFunction(() => document.querySelector('#stage-video').hidden && document.querySelector('#stage-video').muted);
  await new Promise(resolve => setTimeout(resolve, 3200));
  result.pending = { host: await sample(host), viewer: await sample(viewer) };
  for (const state of Object.values(result.pending)) { assert.equal(state.activePeers, 1); assert.equal(state.members, 2); assert.ok(state.senderTracks.every(tracks => tracks.every(track => track === null))); }
  assert.equal(await viewer.evaluate(() => document.querySelector('#stage-video').srcObject === window.__beforePendingStream), true);
  await viewer.screenshot({ path: path.join(output, 'pending-paused.png'), fullPage: true });
  pass('Missing both live path and selected-pair stats for more than 3 seconds still pauses all outbound tracks and hides incoming media without removing members');

  await Promise.all([host, viewer].map(page => page.evaluate(() => { window.__statsMode = 'normal'; })));
  await host.waitForFunction(() => window.__pcs[0].getSenders().some(s => s.track?.kind === 'video'));
  await viewer.waitForFunction(() => window.__pcs[0].getSenders().some(s => s.track?.kind === 'audio'));
  await viewer.waitForFunction(() => !document.querySelector('#stage-video').hidden && Boolean(document.querySelector('#stage-video').srcObject));
  const pausedFrames = result.pending.viewer.frames;
  await viewer.waitForFunction(async minimum => { for (const pc of window.__pcs) for (const stat of (await pc.getStats()).values()) if (stat.type === 'inbound-rtp' && stat.kind === 'video' && stat.framesDecoded > minimum + 5) return true; return false; }, pausedFrames);
  result.restored = { host: await sample(host), viewer: await sample(viewer) };
  assert.ok(result.restored.host.senderTracks[0].includes('video'));
  assert.equal(await viewer.evaluate(() => document.querySelector('#stage-video').srcObject === window.__beforePendingStream), true);
  pass('Restoring valid stats automatically reattaches tracks and resumes newly decoded frames without rejoining');

  await Promise.all([host, viewer].map(page => page.evaluate(() => { window.__statsMode = 'remote-prflx'; })));
  const beforePrflx = result.restored.viewer.frames; await new Promise(resolve => setTimeout(resolve, 2500));
  result.prflx = { host: await sample(host), viewer: await sample(viewer) };
  assert.equal(result.prflx.viewer.activePeers, 1); assert.ok(result.prflx.viewer.frames > beforePrflx);
  assert.ok(result.prflx.host.senderTracks[0].includes('video'));
  pass('A selected remote prflx stat with the exact overlay address remains verified and continues decoding');

  await Promise.all([host, viewer].map(page => page.evaluate(() => { window.__statsMode = 'normal'; })));
  await host.locator('#quality-select').selectOption('720p30');
  await host.waitForFunction(() => window.__pcs[0].getSenders().find(s => s.track?.kind === 'video')?.getParameters().encodings[0].maxBitrate === 1500000);
  await host.locator('#quality-select').selectOption('1080p30');
  await host.locator('#share-btn').click(); await viewer.waitForFunction(() => document.querySelector('#stage-video').hidden);
  await host.locator('#share-btn').click(); await viewer.waitForFunction(() => !document.querySelector('#stage-video').hidden && document.querySelector('#stage-video').videoWidth >= 320);
  pass('Quality changes and stop/restart retain the same room connection and restore adaptive sharing');

  await viewer.evaluate(() => { window.__statsMode = 'bad-address'; });
  await viewer.waitForFunction(() => window.__pcs.some(pc => pc.connectionState === 'closed'));
  result.rejected = await sample(viewer); assert.ok(result.rejected.closedPeers > 0); assert.match(result.rejected.status, /明确不符合私网规则|地址不匹配/);
  await viewer.screenshot({ path: path.join(output, 'invalid-address-rejected.png'), fullPage: true });
  pass('A clearly wrong public address in the selected path is rejected and closes the media peer');
  assert.deepEqual(errors, []);
  assert.equal(result.fixed60.meetsTarget, true, 'Primary 1080p60 target not met: see fixed60 actual resolution, encoded/decoded FPS and limitations; adaptive motion is not a substitute');
  result.passed = true;
} catch (error) {
  result.failure = { name: error.name, message: error.message };
  if (host) result.hostFailure = await sample(host).catch(() => ({}));
  if (viewer) { result.viewerFailure = await sample(viewer).catch(() => ({})); await viewer.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
  throw error;
} finally {
  const serialized = JSON.stringify(result, null, 2);
  const probeName = 'fixed60-probe' + (testCodec ? '-' + testCodec.toLowerCase() : '');
  await writeFile(path.join(output, probeOnly ? probeName + '.json' : 'results.json'), serialized);
  await writeFile(path.join(output, (probeOnly ? probeName + '-' : 'regression-') + runTag + '.json'), serialized);
  for (const context of contexts) await context.close(); await browser.close(); await server.close();
}
}
await runChecks();
