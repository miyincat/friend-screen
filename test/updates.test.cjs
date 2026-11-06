'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { generateKeyPairSync, sign } = require('node:crypto');
const { artifactHash, signedBytes, validManifest, repository } = require('../desktop/update-manifest.cjs');
const { Updates } = require('../desktop/updates.cjs');

test('verified updates require explicit actions and cannot install while sharing or after file tampering', async t => {
  const parent = path.resolve('artifacts');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'updates-test-'));
  t.after(async () => {
    const resolved = await fs.realpath(directory);
    assert.equal(path.dirname(resolved), await fs.realpath(parent));
    assert.match(path.basename(resolved), /^updates-test-/);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  await fs.writeFile(path.join(directory, 'friend-screen-update.json'), JSON.stringify({
    repository: '', publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  }));
  const installer = path.join(directory, 'FriendScreen-0.4.7-Setup-x64.exe');
  const bytes = Buffer.from('verified test installer');
  await fs.writeFile(installer, bytes);
  const sha512 = await artifactHash(installer);
  const file = { url: path.basename(installer), sha512, size: bytes.length, isAdminRightsRequired: true };
  const info = {
    version: '0.4.7', files: [file], path: file.url, sha512,
    releaseDate: '2026-11-06T00:00:00.000Z', releaseNotes: 'Signed release notes',
  };
  info.friendScreenSignature = sign(null, signedBytes(info), privateKey).toString('base64');
  assert.ok(validManifest(info, publicKey));
  assert.ok(!validManifest({ ...info, releaseNotes: 'tampered' }, publicKey));
  assert.ok(!validManifest({ ...info, files: [{ ...file, url: 'https://other.test/evil.exe' }] }, publicKey));
  assert.throws(() => repository('https://github.com.evil.test/user/repo'));

  let received = { ...info, releaseNotes: 'unsigned text' }, allowed = false, downloadCount = 0;
  const requestedInstall = [];
  const changes = [];
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => ({ updateInfo: received, isUpdateAvailable: true });
  updater.downloadUpdate = async () => {
    downloadCount++;
    updater.emit('download-progress', { percent: 55 });
    return [installer];
  };
  updater.quitAndInstall = (...args) => requestedInstall.push(args);
  const controller = new Updates({
    app: { isPackaged: true, getVersion: () => '0.4.6', getPath: () => directory },
    resources: directory, publish: change => changes.push(change), canRestart: () => allowed,
    createUpdater: url => {
      assert.equal(url, 'https://github.com/example/friend-screen-releases/releases/latest/download/');
      return updater;
    },
  });
  await controller.load();
  assert.equal(controller.state.phase, 'unconfigured');
  await controller.action('configure', 'https://github.com/example/friend-screen-releases/');
  assert.equal(controller.state.phase, 'idle');
  await controller.action('check');
  assert.equal(controller.state.phase, 'error');
  await controller.action('download');
  assert.equal(downloadCount, 0);
  received = info;
  await controller.action('check');
  assert.equal(controller.state.phase, 'available');
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(downloadCount, 0);
  await controller.action('download');
  assert.equal(controller.state.phase, 'ready');
  assert.equal(controller.state.progress, 100);
  assert.ok(changes.some(change => change.phase === 'downloading' && change.progress === 55));
  await controller.action('install');
  assert.equal(controller.state.phase, 'ready');
  assert.deepEqual(requestedInstall, []);
  allowed = true;
  await fs.appendFile(installer, 'tampered');
  await controller.action('install');
  assert.equal(controller.state.phase, 'available');
  assert.deepEqual(requestedInstall, []);
  await fs.writeFile(installer, bytes);
  await controller.action('download');
  await controller.action('install');
  assert.deepEqual(requestedInstall, [[false, true]]);
});
