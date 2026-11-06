import http from 'node:http';
import https from 'node:https';
import { readFile, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { WebSocketServer, WebSocket } from 'ws';
import { createAccounts, validAvatar } from './accounts.mjs';
import path from 'node:path';
import { overlayCandidate, overlayDescription } from './network/media-policy.mjs';
import { buildMediaTree, isMediaRoute } from './network/media-tree.mjs';

const scrypt = promisify(scryptCallback);
const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/piik-media.js', ['piik-media.js', 'text/javascript; charset=utf-8']],
  ['/diagnostic-telemetry.js', ['diagnostic-telemetry.js', 'text/javascript; charset=utf-8']],
  ['/media-controls.js', ['media-controls.js', 'text/javascript; charset=utf-8']],
  ['/share-settings.js', ['share-settings.js', 'text/javascript; charset=utf-8']],
  ['/source-picker.js', ['source-picker.js', 'text/javascript; charset=utf-8']],
  ['/share-settings.css', ['share-settings.css', 'text/css; charset=utf-8']],
  ['/pending-signals.js', ['pending-signals.js', 'text/javascript; charset=utf-8']],
  ['/profile.js', ['profile.js', 'text/javascript; charset=utf-8']],
  ['/media-policy.js', ['../network/media-policy.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

export function readConfig(env = process.env) {
  const config = {
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 8787),
    publicOrigin: env.PUBLIC_ORIGIN || null,
    siteAccessKey: env.SITE_ACCESS_KEY || '',
    stunUrls: (env.STUN_URLS || '').split(',').map(x => x.trim()).filter(Boolean),
    turnUrls: (env.TURN_URLS || '').split(',').map(x => x.trim()).filter(Boolean),
    turnSecret: env.TURN_SECRET || '',
    relayOnly: env.ICE_RELAY_ONLY === 'true',
    tlsCert: env.TLS_CERT || '',
    tlsKey: env.TLS_KEY || '',
    maxParticipants: 6,
    dataDir: env.ACCOUNT_DATA_DIR === ':memory:' ? null : (env.ACCOUNT_DATA_DIR || path.resolve('data')),
  };
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('PORT 无效');
  if (config.publicOrigin) {
    const origin = new URL(config.publicOrigin);
    if (origin.protocol !== 'https:' || origin.origin !== config.publicOrigin) throw new Error('PUBLIC_ORIGIN 必须是无末尾斜杠的 HTTPS origin');
    if (config.siteAccessKey.length < 16) throw new Error('公网部署必须设置至少 16 个字符的 SITE_ACCESS_KEY');
  } else if (!['127.0.0.1', '::1', 'localhost'].includes(config.host)) {
    throw new Error('对外监听需配置 PUBLIC_ORIGIN 和 SITE_ACCESS_KEY；本机测试请保持默认 HOST');
  }
  if (Boolean(config.tlsCert) !== Boolean(config.tlsKey)) throw new Error('TLS_CERT 与 TLS_KEY 必须一起提供');
  for (const url of config.stunUrls) if (!/^stuns?:[^\s]+$/.test(url)) throw new Error('STUN_URLS 格式错误');
  for (const url of config.turnUrls) if (!/^turns?:[^\s]+$/.test(url)) throw new Error('TURN_URLS 格式错误');
  if (config.turnUrls.length && config.turnSecret.length < 32) throw new Error('TURN_SECRET 至少需要 32 个字符，且必须与 coturn 的 static-auth-secret 一致');
  if (config.relayOnly && !config.turnUrls.length) throw new Error('ICE_RELAY_ONLY 需要 TURN_URLS');
  return config;
}

const digest = value => createHash('sha256').update(value).digest();
const fail = (ws, code, message) => send(ws, { type: 'error', code, message });
const send = (ws, message) => {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > 1024 * 1024) { ws.close(1013, 'slow client'); return; }
  ws.send(JSON.stringify(message));
};

export function createApp(config = readConfig()) {
  const rooms = new Map();
  const buckets = new Map();
  let pendingAuth = 0;
  let boundPort = config.port;
  const siteDigest = digest(config.siteAccessKey);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const allowedHost = host => {
    if (config.overlay) return host === `${config.host}:${boundPort}`;
    if (config.publicOrigin) return host === new URL(config.publicOrigin).host;
    return [`localhost:${boundPort}`, `127.0.0.1:${boundPort}`, `[::1]:${boundPort}`].includes(host);
  };
  const allowedOrigin = origin => {
    if (config.overlay) return origin === `http://${config.host}:${boundPort}`;
    if (config.publicOrigin) return origin === config.publicOrigin;
    const protocol = config.tlsCert ? 'https' : 'http';
    return [`${protocol}://localhost:${boundPort}`, `${protocol}://127.0.0.1:${boundPort}`, `${protocol}://[::1]:${boundPort}`].includes(origin);
  };
  function quota(key, limit, period = 60000) {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= now) {
      if (buckets.size >= 4096) return false;
      bucket = { count: 0, until: now + period };
      buckets.set(key, bucket);
    }
    return ++bucket.count <= limit;
  }
  const accounts = createAccounts({ dataDir: config.dataDir, secure: Boolean(config.publicOrigin || config.tlsCert), allowedOrigin, quota, siteAccessKey: config.siteAccessKey,
    onProfile(profile) {
      for (const ws of wss.clients) if (ws.accountId === profile.id) {
        ws.name = profile.name; ws.avatar = profile.avatar;
        const room = rooms.get(ws.roomId);
        if (room) broadcast(room, { type: 'peer-profile', peerId: ws.id, name: ws.name, avatar: ws.avatar });
      }
    },
    onLogout(sessionHash) { for (const ws of wss.clients) if (ws.sessionHash === sessionHash) ws.close(1008, 'signed out'); },
  });
  function handler(req, res) {
    const headers = {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(self), display-capture=(self)',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'Cache-Control': 'no-store',
    };
    if (config.publicOrigin || config.tlsCert) headers['Strict-Transport-Security'] = 'max-age=31536000';
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
    if (!allowedHost(req.headers.host)) { res.writeHead(421); res.end('Unknown host'); return; }
    let path;
    try { path = new URL(req.url, 'http://localhost').pathname; } catch { res.writeHead(400); res.end(); return; }
    if (config.overlay) {
      config.overlay.handleHttp(req, res, path).catch(() => { if (!res.headersSent) res.writeHead(400); res.end(JSON.stringify({ error: '私网请求失败' })); });
      return;
    }
    if (path === '/api/account' || path.startsWith('/api/account/')) {
      accounts.handle(req, res, path).catch(() => { if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '账号操作失败，请稍后重试' })); });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    const json = value => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(value));
    };
    if (path === '/healthz') { json({ ok: true }); return; }
    if (path === '/api/config') {
      json({ maxParticipants: config.maxParticipants, publicOrigin: config.publicOrigin,
        hasTurn: config.turnUrls.length > 0, icePolicy: config.relayOnly ? 'relay' : 'all',
        requiresAccessKey: Boolean(config.siteAccessKey) });
      return;
    }
    const entry = staticFiles.get(path);
    if (!entry) { res.writeHead(404); res.end('Not found'); return; }
    readFile(publicDir + entry[0], (err, data) => {
      if (err) { res.writeHead(500); res.end('Page unavailable'); return; }
      res.writeHead(200, { 'Content-Type': entry[1] });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }
  const server = config.tlsCert
    ? https.createServer({ cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey) }, handler)
    : http.createServer(handler);
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;

  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws' || !allowedHost(req.headers.host) || !allowedOrigin(req.headers.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    const ip = req.socket.remoteAddress || 'unknown';
    if (wss.clients.size >= 128 || !quota('connect:' + ip, 120)) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); return;
    }
    if (config.overlay) {
      try { req.member = config.overlay.authenticate(req); req.hostProof = config.overlay.hostProof(req); }
      catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  function broadcast(room, message, except) {
    for (const peer of room.peers.values()) if (peer !== except) send(peer, message);
  }
  function iceServers(id) {
    if(config.overlay)return [];
    const servers = [];
    if (config.stunUrls.length) servers.push({ urls: config.stunUrls });
    if (config.turnUrls.length) {
      const username = `${Math.floor(Date.now() / 1000) + 86400}:${id}`;
      const credential = createHmac('sha1', config.turnSecret).update(username).digest('base64');
      servers.push({ urls: config.turnUrls, username, credential });
    }
    return servers;
  }
  function leave(ws) {
    const room = rooms.get(ws.roomId);
    ws.roomId = null;
    if (!room) return;
    if ((config.overlay || config.nativeMedia) && room.ownerId === ws.id) {
      rooms.delete(room.id);
      for (const peer of room.peers.values()) if (peer !== ws) {
        peer.roomId = null; send(peer, { type: 'room-closed', message: '房主已离开或断网，房间已结束。' }); peer.close(1000, 'host left');
      }
      room.peers.clear(); return;
    }
    room.peers.delete(ws.id);
    if (room.presenterId === ws.id) {
      room.presenterId = null;
      room.shareId = null;
      broadcast(room, { type: 'presenter', peerId: null });
    }
    broadcast(room, { type: 'peer-left', peerId: ws.id });
    updateMediaTree(room);
    if (!room.peers.size) rooms.delete(room.id);
    ws.mic = false;
  }
  function admit(ws, room, name) {
    if (config.nativeMedia && [...room.peers.values()].some(peer => peer.name === name)) name = name.slice(0,19) + '-' + ws.id.slice(-4);
    if (config.overlay) {
      const previous = room.peers.get(ws.id);
      if (previous) { previous.roomId = null; room.peers.delete(ws.id); previous.close(1000, 'reconnected'); broadcast(room,{type:'peer-left',peerId:ws.id}); }
      if ([...room.peers.values()].some(peer => peer.name === name)) name = name.slice(0, 19) + '-' + ws.id.slice(-4);
    }
    ws.name = name;
    ws.roomId = room.id;
    const peers = Array.from(room.peers.values(), peer => ({ id: peer.id, name: peer.name, mic: peer.mic, ...(config.overlay ? { address: peer.request.member.address, nodeId:peer.request.member.nodeId||'' } : {}), ...(peer.avatar ? { avatar: peer.avatar } : {}) }));
    room.peers.set(ws.id, ws);
    clearTimeout(ws.joinTimeout);
    send(ws, { type: 'joined', selfId: ws.id, roomId: room.id, peers, presenterId: room.presenterId,
      iceServers: iceServers(ws.id), iceTransportPolicy: config.relayOnly ? 'relay' : 'all', maxParticipants: config.maxParticipants,
      ...(config.nativeMedia ? {nativeMedia:true,displayName:name} : {}),
      ...(config.overlay ? { overlay: true, address: ws.request.member.address, displayName: name } : {}) });
    broadcast(room, { type: 'peer-joined', peer: { id: ws.id, name, mic: false, ...(config.overlay ? { address: ws.request.member.address, nodeId:ws.request.member.nodeId||'' } : {}), ...(ws.avatar ? { avatar: ws.avatar } : {}) } }, ws);
    updateMediaTree(room);
  }
  function updateMediaTree(room) {
    if (!config.nativeMedia) return;
    room.mediaEdges = room.shareId ? buildMediaTree([...room.peers.keys()], room.presenterId, room.mediaEdges || []) : [];
    broadcast(room,{type:'media-tree',shareId:room.shareId || null,presenterId:room.presenterId,edges:room.mediaEdges,addresses:Object.fromEntries([...room.peers.values()].map(peer=>[peer.id,peer.request.member?.address]))});
  }
  async function receive(ws, msg) {
    if (config.overlay?.isRevoked(ws.id)) { ws.close(1008,'device revoked'); return; }
    if (ws.accountId && !accounts.session(ws.request)) { ws.close(1008, 'session expired'); return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) { fail(ws, 'BAD_MESSAGE', '消息格式无效'); return; }
    if (msg.type === 'create' || msg.type === 'join') {
      if(config.nativeMedia && msg.nativeMediaVersion!==1){fail(ws,'UPGRADE_REQUIRED','此房间使用原生私网媒体，请所有成员升级到 0.3.6。');return;}
      if (ws.roomId) { fail(ws, 'ALREADY_JOINED', '请先离开当前房间'); return; }
      if (!quota('auth:' + ws.ip, 40)) { fail(ws, 'RATE_LIMIT', '尝试过于频繁，请一分钟后再试'); return; }
      if (config.siteAccessKey && (typeof msg.accessKey !== 'string' || msg.accessKey.length > 512 || !timingSafeEqual(digest(msg.accessKey), siteDigest))) {
        fail(ws, 'ACCESS_DENIED', '站点口令不正确'); return;
      }
      const account = accounts.user(ws.request);
      const name = account ? account.name : typeof msg.name === 'string' ? msg.name.trim() : '';
      const avatar = account ? account.avatar : msg.avatar || '';
      if (!validAvatar(avatar)) { fail(ws, 'BAD_AVATAR', '头像格式无效'); return; }
      ws.avatar = avatar;
      if (!name || name.length > 24 || /[\x00-\x1f\x7f]/.test(name)) { fail(ws, 'BAD_NAME', '昵称需要 1–24 个字符'); return; }
      if (!config.overlay && (typeof msg.password !== 'string' || msg.password.length < 8 || msg.password.length > 128)) {
        fail(ws, 'BAD_PASSWORD', '房间口令需要 8–128 个字符'); return;
      }
      if (pendingAuth >= 8) { fail(ws, 'BUSY', '服务器繁忙，请稍后重试'); return; }
      if (msg.type === 'create') {
        if (config.overlay && ws.request.member.address !== config.host) { fail(ws,'NOT_HOST','只能在自己的电脑创建房间'); return; }
        if (rooms.size >= 32) { fail(ws, 'ROOM_LIMIT', '房间数已达上限'); return; }
        const salt = randomBytes(16);
        pendingAuth++;
        let passwordHash;
        try { passwordHash = config.overlay ? null : await scrypt(msg.password, salt, 32); } finally { pendingAuth--; }
        if (ws.readyState !== WebSocket.OPEN) return;
        if (rooms.size >= 32) { fail(ws, 'ROOM_LIMIT', '房间数已达上限'); return; }
        let id;
        do { id = config.overlay ? config.overlay.roomCode() : randomBytes(6).toString('hex').toUpperCase(); } while (rooms.has(id));
        const room = { id, salt, passwordHash, peers: new Map(), presenterId: null, ownerId: ws.id };
        rooms.set(id, room);
        admit(ws, room, name);
      } else {
        const roomId = typeof msg.roomId === 'string' ? (config.overlay ? msg.roomId.trim() : msg.roomId.trim().toUpperCase()) : '';
        const room = rooms.get(roomId);
        if (!room) { fail(ws, 'JOIN_DENIED', '房间不存在或口令不正确'); return; }
        pendingAuth++;
        let candidate;
        try { candidate = config.overlay ? null : await scrypt(msg.password, room.salt, 32); } finally { pendingAuth--; }
        if (ws.readyState !== WebSocket.OPEN) return;
        if (rooms.get(roomId) !== room || (!config.overlay && !timingSafeEqual(candidate, room.passwordHash))) {
          fail(ws, 'JOIN_DENIED', '房间不存在或口令不正确'); return;
        }
        if (room.peers.size >= config.maxParticipants && !room.peers.has(ws.id)) { fail(ws, 'ROOM_FULL', `房间已满，最多 ${config.maxParticipants} 人`); return; }
        admit(ws, room, name);
      }
      return;
    }
    const room = rooms.get(ws.roomId);
    if (!room) { fail(ws, 'NOT_JOINED', '请先加入房间'); return; }
    if (msg.type === 'leave') { leave(ws); return; }
    if (msg.type === 'present') {
      if (typeof msg.active !== 'boolean') { fail(ws, 'BAD_MESSAGE', '共享状态无效'); return; }
      if (msg.active) {
        if(config.nativeMedia && (typeof msg.shareId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(msg.shareId))) { fail(ws,'BAD_SHARE','原生共享标识无效');return; }
        if (room.presenterId && room.presenterId !== ws.id) { fail(ws, 'PRESENTER_BUSY', '已有朋友在共享屏幕'); return; }
        room.presenterId = ws.id;
        if(config.nativeMedia) room.shareId = msg.shareId;
      } else {
        if (room.presenterId !== ws.id) { fail(ws, 'NOT_PRESENTER', '只有分享者能停止本次共享'); return; }
        room.presenterId = null;
        room.shareId = null;
      }
      broadcast(room, { type: 'presenter', peerId: room.presenterId });
      updateMediaTree(room);
    } else if(config.nativeMedia && msg.type === 'screen-signal') {
      const target = room.peers.get(msg.to);
      if(!target || !room.shareId || msg.shareId!==room.shareId || !isMediaRoute(room.mediaEdges || [],ws.id,msg.to,msg.connectionId)) {fail(ws,'STALE_MEDIA_ROUTE','媒体路径已经更新');return;}
      const p=msg.payload;
      if(!p || typeof p!=='object' || Array.isArray(p) || Object.keys(p).length!==1) {fail(ws,'BAD_SIGNAL','媒体信令无效');return;}
      const profile=p.profile||p.description?.profile;
      if (profile) {
        const resolution = profile.resolution;
        const forward = room.mediaEdges.some(edge =>
          edge.connectionId === msg.connectionId && edge.from === ws.id && edge.to === msg.to);
        if (!forward || !resolution ||
            !Number.isInteger(resolution.width) || resolution.width < 320 || resolution.width > 2560 ||
            !Number.isInteger(resolution.height) || resolution.height < 180 || resolution.height > 1440 ||
            !Number.isInteger(profile.maxFramerate) || profile.maxFramerate < 15 || profile.maxFramerate > 60 ||
            !Number.isInteger(profile.maxBitrate) || profile.maxBitrate < 500000 || profile.maxBitrate > 20000000 ||
            profile.maxAudioBitrate !== 192000 ||
            !['balanced', 'maintain-framerate', 'maintain-resolution'].includes(profile.degradationPreference)) {
          fail(ws, 'BAD_SIGNAL', '共享画质参数无效');
          return;
        }
      }
      if(p.description) {if(!['offer','answer'].includes(p.description.type)||typeof p.description.sdp!=='string'||p.description.sdp.length>60000){fail(ws,'BAD_SIGNAL','媒体描述无效');return;}}
      else if(Object.hasOwn(p,'candidate')) {const c=p.candidate;if(c!==null&&(!c||typeof c.candidate!=='string'||c.candidate.length>4096|| (c.sdpMid!=null&&typeof c.sdpMid!=='string') || (c.sdpMLineIndex!=null&&(!Number.isInteger(c.sdpMLineIndex)||c.sdpMLineIndex<0||c.sdpMLineIndex>32)))){fail(ws,'BAD_SIGNAL','媒体候选无效');return;}}
      else if(!p.profile) {fail(ws,'BAD_SIGNAL','媒体信令无效');return;}
      if(config.overlay){if(p.description)p.description={...p.description,...overlayDescription(p.description,ws.request.member.address)};else if(Object.hasOwn(p,'candidate')&&!overlayCandidate(p.candidate,ws.request.member.address)){fail(ws,'BAD_SIGNAL','只允许认证私网地址的 UDP 媒体候选');return;}}
      send(target,{type:'screen-signal',from:ws.id,shareId:room.shareId,connectionId:msg.connectionId,payload:p});
    } else if(config.nativeMedia && msg.type==='screen-repair') {
      const edge=(room.mediaEdges||[]).find(e=>e.connectionId===msg.connectionId&&(e.from===ws.id||e.to===ws.id));
      if(edge && quota('repair:'+ws.id,3,60000)){edge.connectionId=randomUUID();updateMediaTree(room);}
    } else if (msg.type === 'mic') {
      if (typeof msg.active !== 'boolean') { fail(ws, 'BAD_MESSAGE', '麦克风状态无效'); return; }
      ws.mic = msg.active;
      broadcast(room, { type: 'peer-state', peerId: ws.id, mic: ws.mic });
    } else if (msg.type === 'profile') {
      if (ws.accountId || !validAvatar(msg.avatar)) { fail(ws, 'BAD_PROFILE', '请通过个人资料修改头像'); return; }
      if (msg.name !== undefined) {
        if (typeof msg.name !== 'string' || !msg.name.trim() || msg.name.trim().length > 24 || /[\x00-\x1f\x7f]/.test(msg.name)) { fail(ws, 'BAD_NAME', '昵称需要 1–24 个字符'); return; }
        ws.name = msg.name.trim();
        if (config.overlay && [...room.peers.values()].some(peer=>peer!==ws && peer.name===ws.name)) ws.name=ws.name.slice(0,19)+'-'+ws.id.slice(-4);
      }
      ws.avatar = msg.avatar;
      broadcast(room, { type: 'peer-profile', peerId: ws.id, name: ws.name, avatar: ws.avatar });
    } else if (msg.type === 'signal') {
      const target = room.peers.get(msg.to);
      if (!target || target === ws) { fail(ws, 'PEER_MISSING', '接收方已离开当前房间'); return; }
      const payload = msg.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { fail(ws, 'BAD_SIGNAL', '信令格式无效'); return; }
      const hasDescription = Object.hasOwn(payload, 'description');
      const hasCandidate = Object.hasOwn(payload, 'candidate');
      if (hasDescription === hasCandidate) { fail(ws, 'BAD_SIGNAL', '信令格式无效'); return; }
      let clean;
      if (hasDescription) {
        const d = payload.description;
        if (!d || !['offer', 'answer'].includes(d.type) || typeof d.sdp !== 'string' || d.sdp.length > 60000) { fail(ws, 'BAD_SIGNAL', '会话描述无效'); return; }
        clean = { description: config.overlay ? overlayDescription(d, ws.request.member.address) : { type: d.type, sdp: d.sdp } };
      } else {
        const c = payload.candidate;
        if (c === null) clean = { candidate: null };
        else {
          if (!c || typeof c !== 'object' || typeof c.candidate !== 'string' || c.candidate.length > 4096 ||
            (c.sdpMid != null && (typeof c.sdpMid !== 'string' || c.sdpMid.length > 256)) ||
            (c.sdpMLineIndex != null && (!Number.isInteger(c.sdpMLineIndex) || c.sdpMLineIndex < 0 || c.sdpMLineIndex > 32)) ||
            (c.usernameFragment != null && (typeof c.usernameFragment !== 'string' || c.usernameFragment.length > 256))) {
            fail(ws, 'BAD_SIGNAL', 'ICE 候选无效'); return;
          }
          if (config.overlay && !overlayCandidate(c, ws.request.member.address)) { fail(ws, 'BAD_SIGNAL', '仅允许当前设备的私网媒体地址'); return; }
          clean = { candidate: { candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null, usernameFragment: c.usernameFragment ?? null } };
        }
      }
      send(target, { type: 'signal', from: ws.id, payload: clean });
    } else fail(ws, 'BAD_MESSAGE', '不支持的消息类型');
  }
  wss.on('connection', (ws, req) => {
    if (config.overlay) send(ws,{type:'host-proof',token:req.hostProof});
    ws.request = req; ws.accountId = accounts.user(req)?.id || null; ws.sessionHash = accounts.session(req)?.hash || null;
    ws.id = req.member?.deviceId || randomUUID(); ws.ip = req.socket.remoteAddress || 'unknown';
    ws.roomId = null; ws.mic = false; ws.alive = true;
    let queue = Promise.resolve(); let queued = 0; let count = 0; let windowStart = Date.now();
    ws.joinTimeout = setTimeout(() => { if (!ws.roomId) ws.close(1008, 'join timeout'); }, 60000);
    ws.joinTimeout.unref();
    ws.on('pong', () => { ws.alive = true; });
    ws.on('error', () => {});
    ws.on('message', (data, isBinary) => {
      if (Date.now() - windowStart > 10000) { windowStart = Date.now(); count = 0; }
      if (++count > 300 || queued >= 80) { ws.close(1008, 'rate limit'); return; }
      if (isBinary) { fail(ws, 'BAD_MESSAGE', '只接受 JSON 文本'); return; }
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { fail(ws, 'BAD_MESSAGE', 'JSON 格式无效'); return; }
      queued++;
      queue = queue.then(() => { if (ws.readyState === WebSocket.OPEN) return receive(ws, msg); })
        .catch(() => fail(ws, 'INTERNAL', '操作失败，请重试'))
        .finally(() => { queued--; });
    });
    ws.on('close', () => { clearTimeout(ws.joinTimeout); leave(ws); });
  });
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) if (bucket.until <= now) buckets.delete(key);
    for (const ws of wss.clients) {
      if (!ws.alive || config.overlay?.isRevoked(ws.id)) { ws.terminate(); continue; }
      ws.alive = false; ws.ping();
    }
  }, 30000);
  timer.unref();
  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => { server.removeListener('error', reject); resolve(); });
      });
      boundPort = server.address().port;
      return boundPort;
    },
    async close() {
      clearInterval(timer);
      for (const ws of wss.clients) { clearTimeout(ws.joinTimeout); ws.terminate(); }
      await new Promise(resolve => wss.close(resolve));
      if (server.listening) await new Promise(resolve => server.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = readConfig();
    const app = createApp(config);
    const port = await app.listen();
    console.log(`同屏小屋已启动：${config.publicOrigin || `${config.tlsCert ? 'https' : 'http'}://localhost:${port}`}`);
    if (!config.turnUrls.length) console.log('未配置 TURN：仅完成本机/局域网络的基础配置，异地连通性没有保证。');
    let closing = false;
    const shutdown = async () => { if (closing) return; closing = true; await app.close(); };
    process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  } catch (err) { console.error('启动失败：' + err.message); process.exitCode = 1; }
}
