import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const hash = value => createHash('sha256').update(value).digest('hex');
export function validAvatar(value) {
  if (value === '') return true;
  if (typeof value !== 'string' || value.length > 32768 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const b = Buffer.from(value.slice(23), 'base64');
  if (b.length < 20 || b[0] !== 255 || b[1] !== 216 || b[b.length - 2] !== 255 || b[b.length - 1] !== 217) return false;
  // Accept only small baseline/progressive JPEG images, never remote URLs or SVG.
  for (let i = 2; i + 8 < b.length;) {
    if (b[i++] !== 255) return false;
    while (b[i] === 255) i++;
    const marker = b[i++];
    if (marker === 218 || marker === 217) break;
    const size = b.readUInt16BE(i);
    if (size < 2 || i + size > b.length) return false;
    if (marker === 192 || marker === 194) {
      const h = b.readUInt16BE(i + 3), w = b.readUInt16BE(i + 5);
      return w > 0 && h > 0 && w <= 256 && h <= 256;
    }
    i += size;
  }
  return false;
}
const validName = v => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 24 && !/[\x00-\x1f\x7f]/.test(v);
const publicUser = u => ({ id: u.id, username: u.username, name: u.name, avatar: u.avatar, micVolume: u.micVolume });

export function createAccounts({ dataDir, secure, allowedOrigin, quota, siteAccessKey, onProfile, onLogout }) {
  const file = dataDir ? path.join(dataDir, 'accounts.json') : null;
  let db = { users: [], sessions: [] };
  if (file) {
    try { db = JSON.parse(readFileSync(file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw new Error('账号数据无法读取，请恢复备份后启动。'); }
    if (!Array.isArray(db.users) || !Array.isArray(db.sessions)) throw new Error('账号数据格式无效');
  }
  const cookieName = secure ? '__Host-friend_session' : 'friend_session';
  let busy = 0;
  function save() {
    db.sessions = db.sessions.filter(s => s.expires > Date.now());
    if (!file) return;
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file + '.tmp', JSON.stringify(db), { mode: 0o600 });
    renameSync(file + '.tmp', file);
  }
  function session(req) {
    const token = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    return db.sessions.find(s => s.hash === hash(token) && s.expires > Date.now()) || null;
  }
  function user(req) { const s = session(req); return s ? db.users.find(u => u.id === s.userId) : null; }
  function cookie(res, token, remember, clear = false) {
    res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}${clear ? '; Max-Age=0' : remember ? '; Max-Age=2592000' : ''}`);
  }
  function answer(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
  async function handle(req, res, route) {
    if (route === '/api/account' && req.method === 'GET') { answer(res, 200, { user: user(req) ? publicUser(user(req)) : null }); return; }
    if (req.method !== 'POST') { answer(res, 405, { error: '不支持此操作' }); return; }
    if (!allowedOrigin(req.headers.origin) || req.headers['content-type']?.split(';')[0] !== 'application/json') { answer(res, 403, { error: '请求来源无效' }); return; }
    if (!quota('account:' + req.socket.remoteAddress, 60)) { answer(res, 429, { error: '操作过于频繁，请稍后再试' }); return; }
    let bytes = 0, chunks = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 40000) { answer(res, 413, { error: '资料过大' }); return; }
      chunks.push(chunk);
    }
    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString()); } catch { answer(res, 400, { error: '资料格式无效' }); return; }
    if (!input || typeof input !== 'object' || Array.isArray(input)) { answer(res, 400, { error: '资料格式无效' }); return; }
    if (route === '/api/account/logout') {
      const current = session(req);
      if (current) { db.sessions = db.sessions.filter(s => s !== current); save(); onLogout(current.hash); }
      cookie(res, '', false, true); answer(res, 200, { ok: true }); return;
    }
    if (route === '/api/account/profile') {
      const account = user(req);
      if (!account) { answer(res, 401, { error: '登录已过期，请重新登录' }); return; }
      if (!validName(input.name) || !validAvatar(input.avatar) || !Number.isInteger(input.micVolume) || input.micVolume < 0 || input.micVolume > 200) {
        answer(res, 400, { error: '昵称、头像或音量格式无效' }); return;
      }
      Object.assign(account, { name: input.name.trim(), avatar: input.avatar, micVolume: input.micVolume });
      save(); onProfile(publicUser(account)); answer(res, 200, { user: publicUser(account) }); return;
    }
    if (!['/api/account/register', '/api/account/login'].includes(route)) { answer(res, 404, { error: '操作不存在' }); return; }
    if (siteAccessKey && (typeof input.accessKey !== 'string' || hash(input.accessKey) !== hash(siteAccessKey))) { answer(res, 403, { error: '请填写正确的站点口令' }); return; }
    const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
    if (!/^[a-z0-9_]{3,32}$/.test(username) || typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 128) {
      answer(res, 400, { error: '账号需 3–32 位字母、数字或下划线；密码需 8–128 位' }); return;
    }
    if (busy >= 4 || !quota('account-login:' + req.socket.remoteAddress, 15) || !quota('account-user:' + username, 30)) { answer(res, 429, { error: '登录尝试过多，请一分钟后再试' }); return; }
    busy++;
    try {
      let account = db.users.find(u => u.username === username);
      if (route.endsWith('/register')) {
        if (!validName(input.name)) { answer(res, 400, { error: '昵称需要 1–24 个字符' }); return; }
        if (account || db.users.length >= 1000) { answer(res, 409, { error: '此账号不可注册，请换一个账号' }); return; }
        const salt = randomBytes(16).toString('hex');
        const key = (await derive(input.password, salt, 64)).toString('hex');
        if (db.users.some(u => u.username === username) || db.users.length >= 1000) { answer(res, 409, { error: '此账号不可注册' }); return; }
        account = { id: randomUUID(), username, name: input.name.trim(), avatar: '', micVolume: 100, salt, key };
        db.users.push(account);
      } else {
        const key = await derive(input.password, account?.salt || '00000000000000000000000000000000', 64);
        if (!account || !timingSafeEqual(key, Buffer.from(account.key, 'hex'))) { answer(res, 401, { error: '账号或密码不正确' }); return; }
      }
      const previous = session(req);
      if (previous) { db.sessions = db.sessions.filter(s => s !== previous); onLogout(previous.hash); }
      const token = randomBytes(32).toString('hex');
      const existing = db.sessions.filter(s => s.userId === account.id).slice(-7);
      db.sessions = db.sessions.filter(s => s.userId !== account.id).concat(existing);
      db.sessions.push({ hash: hash(token), userId: account.id, expires: Date.now() + (input.remember === true ? 30 : 1) * 86400000 });
      save(); cookie(res, token, input.remember === true);
      answer(res, 200, { user: publicUser(account) });
    } finally { busy--; }
  }
  return { handle, user, session, publicUser };
}
