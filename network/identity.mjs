import { generateKeyPairSync, createHash, createPublicKey, sign, verify, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const PORT = 47873;
export function privateIPv4(value) {
  if (isIP(value) !== 4) return false;
  const [a,b] = value.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
export const fingerprint = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
export function newIdentity() {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  return { deviceId: fingerprint(publicKey), publicKey, privateKey: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
}
function publicKey(pem) {
  if (typeof pem !== 'string' || pem.length > 200) throw new Error('设备公钥无效');
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('设备公钥类型无效');
  return key;
}
export function signObject(value, privateKey, domain) {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  return body + '.' + sign(null, Buffer.from(domain + ':' + body), privateKey).toString('base64url');
}
export function verifyObject(token, key, domain, max = 8192) {
  if (typeof token !== 'string' || token.length > max || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error('签名数据无效');
  const [body, signature] = token.split('.');
  if (!verify(null, Buffer.from(domain + ':' + body), publicKey(key), Buffer.from(signature, 'base64url'))) throw new Error('签名验证失败');
  const value = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('签名内容无效');
  return value;
}
export function makeGroup(networkId, address) {
  if (!/^[0-9a-f]{16}$/i.test(networkId) || !privateIPv4(address)) throw new Error('需要有效的私网 Network ID 与 IPv4 地址');
  const keys = newIdentity();
  return { networkId: networkId.toLowerCase(), address, port: PORT, publicKey: keys.publicKey, privateKey: keys.privateKey, groupId: keys.deviceId,
    invitationVersion: randomBytes(12).toString('hex'), invitationSecret: randomBytes(32).toString('base64url'), revoked: [] };
}
export function invitation(group) {
  return 'FSI1.' + signObject({ networkId: group.networkId, address: group.address, port: group.port, publicKey: group.publicKey, groupId: group.groupId,
    version: group.invitationVersion, secret: group.invitationSecret }, group.privateKey, 'friend-screen-invite-v1');
}
export function parseInvitation(code) {
  if (typeof code !== 'string' || !code.startsWith('FSI1.') || code.length > 2048) throw new Error('邀请码格式错误，请完整复制管理员提供的邀请码');
  let decoded;
  try { decoded = JSON.parse(Buffer.from(code.slice(5).split('.')[0], 'base64url').toString()); }
  catch { throw new Error('邀请码格式错误'); }
  const value = verifyObject(code.slice(5), decoded.publicKey, 'friend-screen-invite-v1', 2048);
  if (!/^[0-9a-f]{16}$/.test(value.networkId) || !privateIPv4(value.address) || value.port !== PORT ||
      fingerprint(value.publicKey) !== value.groupId || !/^[a-f0-9]{24}$/.test(value.version) || !/^[A-Za-z0-9_-]{43}$/.test(value.secret)) throw new Error('邀请码内容无效');
  return value;
}
export function currentInvitation(code, group) {
  const value = parseInvitation(code);
  if (value.groupId !== group.groupId || value.networkId !== group.networkId) throw new Error('邀请码属于另一个小屋');
  const a = Buffer.from(value.secret), b = Buffer.from(group.invitationSecret);
  if (value.version !== group.invitationVersion || a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('邀请码已被撤销或轮换，请向管理员索取新邀请码');
  return value;
}
export function issueMember(group, device) {
  publicKey(device.publicKey);
  if (device.deviceId !== fingerprint(device.publicKey) || group.revoked.includes(device.deviceId)) throw new Error('此设备已被移除或身份无效');
  return signObject({ groupId: group.groupId, deviceId: device.deviceId, publicKey: device.publicKey, issuedAt: Date.now() }, group.privateKey, 'friend-screen-member-v1');
}
export function verifyMember(certificate, group) {
  const value = verifyObject(certificate, group.publicKey, 'friend-screen-member-v1');
  if (value.groupId !== group.groupId || value.deviceId !== fingerprint(value.publicKey) || group.revoked?.includes(value.deviceId)) throw new Error('设备未经批准或已被移除');
  publicKey(value.publicKey);
  return value;
}
export function authorization(device, group, address, audience, nodeId) {
  return signObject({ certificate: device.certificate, address, audience, ...(nodeId?{nodeId}:{}), nonce: randomBytes(16).toString('hex'), at: Date.now() }, device.privateKey, 'friend-screen-connect-v1');
}
export function hostProof(device, address, challenge) {
  if (!/^[a-f0-9]{64}$/.test(challenge || '') || !privateIPv4(address)) throw new Error('房主挑战无效');
  return signObject({certificate:device.certificate,address,challenge,at:Date.now()}, device.privateKey, 'friend-screen-host-v1');
}
export function verifyHostProof(token, group, address, challenge) {
  if (typeof token !== 'string' || token.length > 8192) throw new Error('房主身份无效');
  const unsigned = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
  const member = verifyMember(unsigned.certificate, group);
  const value = verifyObject(token, member.publicKey, 'friend-screen-host-v1');
  if (value.address !== address || value.challenge !== challenge || !Number.isFinite(value.at) || Math.abs(Date.now()-value.at)>60000) throw new Error('房主证明无效或已过期');
  return member;
}
export function verifyAuthorization(token, group, address, audience, nonces) {
  if (typeof token !== 'string' || token.length > 8192) throw new Error('需要设备授权');
  let unsigned;
  try { unsigned = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()); } catch { throw new Error('设备授权格式错误'); }
  const member = verifyMember(unsigned.certificate, group);
  const value = verifyObject(token, member.publicKey, 'friend-screen-connect-v1');
  if (!privateIPv4(address) || value.address !== address || value.audience !== audience || !Number.isFinite(value.at) || Math.abs(Date.now() - value.at) > 60000 || !/^[a-f0-9]{32}$/.test(value.nonce)) throw new Error('设备授权已失效，请重新连接');
  const now = Date.now();
  for (const [key, at] of nonces) if (now - at > 120000) nonces.delete(key);
  const key = member.deviceId + ':' + value.nonce;
  if (nonces.has(key) || nonces.size >= 4096) throw new Error('重复或过于频繁的连接');
  nonces.set(key, now);
  return { ...member, address, ...(typeof value.nodeId==='string'&&/^[a-f0-9]{10}$/.test(value.nodeId)?{nodeId:value.nodeId}:{}) };
}
export function roomCode(groupId, address, port = PORT) {
  if (!privateIPv4(address) || !/^[a-f0-9]{32}$/.test(groupId) || port !== PORT) throw new Error('私网房间地址无效');
  const data = Buffer.alloc(38);
  Buffer.from(groupId, 'hex').copy(data, 0);
  Buffer.from(address.split('.').map(Number)).copy(data, 16);
  data.writeUInt16BE(port, 20);
  randomBytes(16).copy(data, 22);
  const checksum = createHash('sha256').update(data).digest().subarray(0, 4);
  return 'FSR1-' + Buffer.concat([data, checksum]).toString('base64url');
}
export function parseRoomCode(code, groupId) {
  if (typeof code !== 'string' || !/^FSR1-[A-Za-z0-9_-]{56}$/.test(code)) throw new Error('房间号格式错误，请完整复制朋友提供的房间号');
  const data = Buffer.from(code.slice(5), 'base64url');
  const sum = createHash('sha256').update(data.subarray(0, 38)).digest().subarray(0, 4);
  if (data.length !== 42 || !timingSafeEqual(sum, data.subarray(38))) throw new Error('房间号校验失败，可能复制不完整');
  if (data.subarray(0, 16).toString('hex') !== groupId) throw new Error('这个房间属于另一个小屋');
  const address = [...data.subarray(16, 20)].join('.'), port = data.readUInt16BE(20);
  if (!privateIPv4(address) || port !== PORT) throw new Error('房间地址不属于允许的私网');
  return { address, port, code };
}
