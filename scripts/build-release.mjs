import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { build, Platform, Arch } = require('electron-builder');
const { repository, signedBytes, validManifest, artifactHash } = require('../desktop/update-manifest.cjs');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const config = JSON.parse(await fs.readFile(path.join(root, 'electron-builder.json'), 'utf8'));
const feed = process.env.FRIEND_SCREEN_UPDATE_REPOSITORY ? repository(process.env.FRIEND_SCREEN_UPDATE_REPOSITORY) : '';
const release = path.join(root, 'dist', version);
const keyPath = path.resolve(process.env.FRIEND_SCREEN_UPDATE_KEY_FILE ||
  path.join(process.env.LOCALAPPDATA, 'FriendScreen-Release', 'update-signing-key.pem'));
const withinSource = path.relative(root, keyPath);
if (withinSource !== '..' && !withinSource.startsWith('..' + path.sep) && !path.isAbsolute(withinSource)) {
  throw new Error('更新签名私钥必须保存在源码目录外。');
}
await fs.mkdir(path.dirname(keyPath), { recursive: true });
let key;
try { key = createPrivateKey(await fs.readFile(keyPath)); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  key = generateKeyPairSync('ed25519').privateKey;
  await fs.writeFile(keyPath, key.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
}
if (key.asymmetricKeyType !== 'ed25519') throw new Error('更新签名密钥必须为 Ed25519。');
const publicKey = createPublicKey(key).export({ type: 'spki', format: 'pem' });

const artifacts = path.join(root, 'artifacts');
await fs.mkdir(artifacts, { recursive: true });
const staging = await fs.mkdtemp(path.join(artifacts, 'update-build-'));
const channelConfig = path.join(staging, 'friend-screen-update.json');
const updaterConfig = path.join(staging, 'app-update.yml');
const buildConfig = path.join(staging, 'builder.json');
await fs.writeFile(channelConfig, JSON.stringify({ repository: feed, publicKey }));
await fs.writeFile(updaterConfig, 'updaterCacheDirName: friend-screen-updater\n');
await fs.writeFile(buildConfig, JSON.stringify({
  ...config,
  publish: null,
  ...(process.env.FRIEND_SCREEN_ELECTRON_DIST ? { electronDist: process.env.FRIEND_SCREEN_ELECTRON_DIST } : {}),
  extraResources: [
    ...config.extraResources,
    { from: channelConfig, to: 'friend-screen-update.json' },
    { from: updaterConfig, to: 'app-update.yml' },
  ],
}));

await build({
  projectDir: root,
  targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
  publish: 'never',
  config: buildConfig,
});

const name = 'FriendScreen-' + version + '-Setup-x64.exe';
const installer = path.join(release, name);
const { size } = await fs.stat(installer);
await fs.stat(installer + '.blockmap');
const sha512 = await artifactHash(installer);
const notes = await fs.readFile(path.join(root, 'docs', 'release-' + version + '.md'), 'utf8');
const info = {
  version,
  files: [{ url: name, sha512, size, isAdminRightsRequired: true }],
  path: name, sha512, releaseDate: new Date().toISOString(),
  releaseNotes: notes.replace(/^# [^\n]*\n/, '').trim().slice(0, 6000),
};
info.friendScreenSignature = sign(null, signedBytes(info), key).toString('base64');
if (!validManifest(info, publicKey)) throw new Error('更新清单校验失败。');
// JSON is valid YAML and preserves the exact signed text values.
await fs.writeFile(path.join(release, 'latest.yml'), JSON.stringify(info, null, 2) + '\n', 'utf8');
console.log('Release files ready:', path.join(release, 'latest.yml'));
