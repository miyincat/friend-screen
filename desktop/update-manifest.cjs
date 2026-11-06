'use strict';

const { createHash, verify } = require('node:crypto');
const { createReadStream } = require('node:fs');

function repository(value) {
  const match = /^https:\/\/github\.com\/([a-z\d][a-z\d-]{0,38})\/([a-z\d._-]{1,100})\/?$/i.exec(String(value ?? '').trim());
  if (!match || match[2] === '.' || match[2] === '..' || match[2].endsWith('.git')) {
    throw new Error('请输入 GitHub 发布仓库的完整链接。');
  }
  return 'https://github.com/' + match[1] + '/' + match[2];
}

function signedBytes(info) {
  const file = info.files[0];
  return Buffer.from(JSON.stringify([
    'local.friendscreen.private/windows-x64/v1', info.version, file.url, file.sha512,
    file.size, file.isAdminRightsRequired, info.releaseDate, info.releaseNotes,
  ]), 'utf8');
}

function validManifest(info, publicKey) {
  const allowed = ['version', 'files', 'path', 'sha512', 'releaseDate', 'releaseNotes', 'friendScreenSignature'];
  const fileAllowed = ['url', 'sha512', 'size', 'isAdminRightsRequired'];
  if (!info || !publicKey || Object.keys(info).some(key => !allowed.includes(key)) ||
      typeof info.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(info.version) ||
      !Array.isArray(info.files) || info.files.length !== 1 ||
      typeof info.releaseDate !== 'string' || !Number.isFinite(Date.parse(info.releaseDate)) ||
      typeof info.releaseNotes !== 'string' || info.releaseNotes.length > 6000 ||
      typeof info.friendScreenSignature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(info.friendScreenSignature)) return false;
  const [file] = info.files;
  if (!file || Object.keys(file).some(key => !fileAllowed.includes(key)) ||
      file.url !== 'FriendScreen-' + info.version + '-Setup-x64.exe' || info.path !== file.url ||
      typeof file.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512) || info.sha512 !== file.sha512 ||
      !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 2 ** 31 ||
      file.isAdminRightsRequired !== true) return false;
  try { return verify(null, signedBytes(info), publicKey, Buffer.from(info.friendScreenSignature, 'base64')); }
  catch { return false; }
}

async function artifactHash(file) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
}

module.exports = { repository, signedBytes, validManifest, artifactHash };
