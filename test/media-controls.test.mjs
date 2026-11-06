import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { videoBudget, setPlaybackTarget } from '../public/media-controls.js';

test('upload admission shares one encoder budget across children and leaves repair headroom', () => {
  assert.equal(videoBudget(6000000, 8000000, 1), 6000000);
  assert.equal(videoBudget(6000000, 8000000, 2), 3000000);
  for (const upload of [6000000, 8000000, 12000000, 20000000, 40000000]) {
    for (const children of [1, 2]) {
      const perChild = videoBudget(20000000, upload, children);
      assert.ok(perChild * children <= upload * 0.75);
      assert.ok(perChild <= 20000000);
    }
  }
  assert.throws(() => videoBudget(6000000, 8000000, 3));
});

test('smooth playback targets picture and shared sound together; source preview remains automatic', () => {
  const video = { track: { kind: 'video' }, jitterBufferTarget: null };
  const audio = { track: { kind: 'audio' }, jitterBufferTarget: null };
  const pc = { getReceivers: () => [video, audio] };
  assert.deepEqual(setPlaybackTarget(pc, 'smooth'), { targetMs: 600, supported: true });
  assert.equal(video.jitterBufferTarget, 600);
  assert.equal(audio.jitterBufferTarget, 600);
  setPlaybackTarget(pc, 'realtime');
  assert.equal(video.jitterBufferTarget, null);
  assert.equal(audio.jitterBufferTarget, null);
  setPlaybackTarget(pc, 'smooth', true);
  assert.equal(video.jitterBufferTarget, null);
  assert.equal(setPlaybackTarget({ getReceivers: () => [{ track: { kind: 'video' } }] }, 'smooth').supported, false);
});

test('joining and leaving downstream peers reallocates the active share without losing its requested ceiling', async () => {
  const imports = {
    '/media-policy.js': 'network/media-policy.mjs',
    '/diagnostic-telemetry.js': 'public/diagnostic-telemetry.js',
    '/media-controls.js': 'public/media-controls.js',
    '/source-picker.js': 'public/source-picker.js',
  };
  let source = await readFile(new URL('../public/piik-media.js', import.meta.url), 'utf8');
  for (const [name, file] of Object.entries(imports)) source = source.replaceAll(`'${name}'`, JSON.stringify(pathToFileURL(path.resolve(file)).href));
  const previous = globalThis.window;
  globalThis.window = { privateHouse: { onNative() {} } };
  try {
    const { PiikMedia } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    const commands = [];
    const media = new PiikMedia({ send() {}, onStream() {}, onStatus() {}, onStopped() {} });
    media.request = async (type, payload) => { commands.push({ type, payload }); return { sdp: '', codec: 'h264', audio: false }; };
    media.choose = async () => ({ source: { kind: 'window', title: 'fixture', sourceId: '1' }, codec: 'h264', adapterIndex: 0, encoderIndex: 0, audio: false });
    media.createPreview = async () => { media.preview = { stream: { getTracks: () => [] }, pc: { close() {} }, connectionId: 'preview' }; };
    await media.configure({ uploadBudget: 8000000, children: 2 });
    const started = await media.start({ width: 1920, height: 1080, fps: 60 }, 'detail', 6000000);
    assert.equal(commands.find(c => c.type === 'start-share').payload.profile.maxBitrate, 3000000);
    const first = { from: 'self', to: 'a', connectionId: 'first' };
    const second = { from: 'self', to: 'b', connectionId: 'second' };
    const tree = edges => ({ shareId: started.shareId, edges, addresses: { self: '10.2.3.4', a: '10.2.3.5', b: '10.2.3.6' } });
    await media.setTree(tree([first, second]), 'self', []);
    assert.equal(media.currentProfile.maxBitrate, 3000000);
    await media.setTree(tree([first]), 'self', []);
    assert.equal(media.currentProfile.maxBitrate, 6000000);
    assert.equal(media.requestedProfile.maxBitrate, 6000000);
    assert.equal(media.shareId, started.shareId);
    assert.equal(commands.filter(c => c.type === 'start-share').length, 1);
    assert.equal(commands.filter(c => c.type === 'stop-share').length, 0);
    await media.stop();
    assert.equal(media.requestedProfile, null);
  } finally {
    globalThis.window = previous;
  }
});
