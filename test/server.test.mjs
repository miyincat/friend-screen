import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { WebSocket } from 'ws';
import { createApp, readConfig } from '../server.mjs';

const password = 'friends-test-password';
const test = (name, fn) => nodeTest(name, { timeout: 10000 }, fn);

async function fixture(t, env = {}) {
  const config = readConfig({ PORT: '0', ...env });
  const app = createApp(config);
  const port = await app.listen();
  const sockets = new Set();
  const origin = config.publicOrigin || `http://127.0.0.1:${port}`;
  const host = config.publicOrigin ? new URL(config.publicOrigin).host : `127.0.0.1:${port}`;
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await app.close();
  });
  async function connect(headers = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { handshakeTimeout: 2500, headers: { Origin: origin, Host: host, ...headers } });
    sockets.add(ws);
    ws.on('error', () => {});
    const inbox = [];
    const waiters = [];
    ws.on('message', data => {
      const message = JSON.parse(data.toString());
      const i = waiters.findIndex(waiter => waiter.predicate(message));
      if (i < 0) inbox.push(message);
      else {
        const waiter = waiters.splice(i, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    });
    await once(ws, 'open');
    const next = (type, predicate = () => true) => new Promise((resolve, reject) => {
      const matches = message => message.type === type && predicate(message);
      const i = inbox.findIndex(matches);
      if (i >= 0) { resolve(inbox.splice(i, 1)[0]); return; }
      const waiter = { predicate: matches, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const position = waiters.indexOf(waiter);
        if (position >= 0) waiters.splice(position, 1);
        reject(new Error(`Timed out waiting for ${type}; inbox=${JSON.stringify(inbox)}`));
      }, 2500);
      waiters.push(waiter);
    });
    t.after(() => { for (const waiter of waiters) clearTimeout(waiter.timer); });
    return {
      ws, inbox, next,
      send: message => ws.send(JSON.stringify(message)),
      async create(name = '房主', extra = {}) {
        this.send({ type: 'create', name, password, ...extra });
        return next('joined');
      },
      async join(roomId, name = '朋友', extra = {}) {
        this.send({ type: 'join', roomId, name, password, ...extra });
        return next('joined');
      },
      async disconnect() {
        const closed = once(ws, 'close'); ws.close(); await closed;
      },
    };
  }
  function request(path, { method = 'GET', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { Host: host, ...headers }, agent: false }, res => {
        let body = '';
        res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.setTimeout(2500, () => req.destroy(new Error('HTTP request timed out')));
      req.on('error', reject); req.end();
    });
  }
  async function rejectedUpgrade(headers, path = '/ws') {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { handshakeTimeout: 2500, headers: { Origin: origin, Host: host, ...headers } });
      sockets.add(ws);
      ws.on('error', reject);
      ws.on('open', () => { ws.terminate(); reject(new Error('Unexpected WebSocket acceptance')); });
      ws.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); ws.terminate(); });
    });
  }
  return { config, connect, request, rejectedUpgrade };
}

test('配置默认限于本机；公网强制 HTTPS、站点口令和有效 TURN 配置', () => {
  const defaults = readConfig({});
  assert.equal(defaults.host, '127.0.0.1');
  assert.deepEqual(defaults.stunUrls, []);
  assert.deepEqual(defaults.turnUrls, []);
  assert.equal(defaults.maxParticipants, 6);
  const invalid = [
    { PORT: '-1' }, { PORT: '1.5' }, { PORT: '65536' },
    { HOST: '0.0.0.0' }, { PUBLIC_ORIGIN: 'http://example.test' },
    { PUBLIC_ORIGIN: 'https://example.test/' }, { PUBLIC_ORIGIN: 'https://example.test' },
    { TLS_CERT: 'unused.pem' }, { STUN_URLS: 'https://example.test' },
    { TURN_URLS: 'turn:example.test:3478', TURN_SECRET: 'short' },
    { ICE_RELAY_ONLY: 'true' },
  ];
  for (const env of invalid) assert.throws(() => readConfig(env), JSON.stringify(env));
  assert.equal(readConfig({ HOST: '0.0.0.0', PUBLIC_ORIGIN: 'https://example.test', SITE_ACCESS_KEY: 'a'.repeat(16) }).publicOrigin, 'https://example.test');
});

test('创建与加入返回成员状态；昵称当作普通文本保存；错误口令可重试', async t => {
  const f = await fixture(t);
  const owner = await f.connect();
  const room = await owner.create('  <img src=x>  ');
  assert.match(room.roomId, /^[0-9A-F]{12}$/);
  assert.deepEqual(room.peers, []);
  assert.deepEqual(room.iceServers, []);
  assert.equal(room.presenterId, null);
  const guest = await f.connect();
  guest.send({ type: 'join', roomId: room.roomId, name: '访客', password: 'wrong-password' });
  assert.equal((await guest.next('error')).code, 'JOIN_DENIED');
  const admitted = await guest.join(room.roomId.toLowerCase());
  assert.deepEqual(admitted.peers, [{ id: room.selfId, name: '<img src=x>', mic: false }]);
  assert.equal((await owner.next('peer-joined')).peer.id, admitted.selfId);
  assert.equal(JSON.stringify(admitted).includes(password), false);
});

test('异步并发加入不会突破六人上限', async t => {
  const f = await fixture(t);
  const owner = await f.connect();
  const room = await owner.create();
  for (let i = 0; i < 4; i++) await (await f.connect()).join(room.roomId, `成员${i}`);
  const challengers = await Promise.all([f.connect(), f.connect(), f.connect()]);
  const replies = challengers.map(peer => {
    peer.send({ type: 'join', roomId: room.roomId, name: '最后席位', password });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No admission response')), 2500);
      const check = data => {
        const message = JSON.parse(data.toString());
        if (['joined', 'error'].includes(message.type)) { clearTimeout(timer); peer.ws.off('message', check); resolve(message); }
      };
      peer.ws.on('message', check);
    });
  });
  const results = await Promise.all(replies);
  assert.equal(results.filter(message => message.type === 'joined').length, 1);
  assert.deepEqual(results.filter(message => message.type === 'error').map(message => message.code), ['ROOM_FULL', 'ROOM_FULL']);
  const admitted = results.find(message => message.type === 'joined');
  assert.equal(admitted.peers.length, 5);
});

test('同一连接排队的重复创建不能留下两个房间', async t => {
  const f = await fixture(t);
  const peer = await f.connect();
  peer.send({ type: 'create', name: '创建者', password });
  peer.send({ type: 'create', name: '创建者', password });
  const room = await peer.next('joined');
  assert.match(room.roomId, /^[0-9A-F]{12}$/);
  assert.equal((await peer.next('error')).code, 'ALREADY_JOINED');
});

test('信令只能转发到同房间成员，服务端覆盖伪造的发送者身份', async t => {
  const f = await fixture(t);
  const first = await f.connect(); const room = await first.create();
  const second = await f.connect(); const guest = await second.join(room.roomId);
  const outsider = await f.connect(); const otherRoom = await outsider.create();
  const payload = { description: { type: 'offer', sdp: 'v=0\r\n', discarded: 'not forwarded' } };
  first.send({ type: 'signal', to: guest.selfId, from: 'forged', payload });
  assert.deepEqual(await second.next('signal'), { type: 'signal', from: room.selfId, payload: { description: { type: 'offer', sdp: 'v=0\r\n' } } });
  first.send({ type: 'signal', to: otherRoom.selfId, payload });
  assert.equal((await first.next('error')).code, 'PEER_MISSING');
  outsider.send({ type: 'signal', to: guest.selfId, payload: { candidate: null } });
  assert.equal((await outsider.next('error')).code, 'PEER_MISSING');
  assert.equal(outsider.inbox.some(message => message.type === 'signal'), false);
  first.send({ type: 'signal', to: guest.selfId, payload: { candidate: null } });
  assert.deepEqual((await second.next('signal')).payload, { candidate: null });
});

test('分享者独占、非分享者不能停止共享、后来加入者获知当前分享者', async t => {
  const f = await fixture(t);
  const owner = await f.connect(); const room = await owner.create();
  const guest = await f.connect(); await guest.join(room.roomId);
  owner.send({ type: 'present', active: true });
  assert.equal((await guest.next('presenter')).peerId, room.selfId);
  guest.send({ type: 'present', active: true });
  assert.equal((await guest.next('error')).code, 'PRESENTER_BUSY');
  guest.send({ type: 'present', active: false });
  assert.equal((await guest.next('error')).code, 'NOT_PRESENTER');
  const late = await f.connect();
  assert.equal((await late.join(room.roomId)).presenterId, room.selfId);
  owner.send({ type: 'present', active: false });
  assert.equal((await guest.next('presenter')).peerId, null);
});

test('离开释放分享权、广播成员离开，连接可以重新加入', async t => {
  const f = await fixture(t);
  const owner = await f.connect(); const room = await owner.create();
  const guest = await f.connect(); const guestRoom = await guest.join(room.roomId);
  owner.send({ type: 'present', active: true }); await guest.next('presenter');
  owner.send({ type: 'leave' });
  assert.equal((await guest.next('presenter')).peerId, null);
  assert.equal((await guest.next('peer-left')).peerId, room.selfId);
  guest.send({ type: 'present', active: true });
  assert.equal((await guest.next('presenter')).peerId, guestRoom.selfId);
  const rejoined = await owner.join(room.roomId);
  assert.equal(rejoined.presenterId, guestRoom.selfId);
  assert.equal(rejoined.peers.length, 1);
});

test('断线也会释放分享权并通知剩余成员', async t => {
  const f = await fixture(t);
  const owner = await f.connect(); const room = await owner.create();
  const guest = await f.connect(); await guest.join(room.roomId);
  owner.send({ type: 'present', active: true }); await guest.next('presenter');
  await owner.disconnect();
  assert.equal((await guest.next('presenter')).peerId, null);
  assert.equal((await guest.next('peer-left')).peerId, room.selfId);
});

test('最后一个成员离开后房间立即消失', async t => {
  const f = await fixture(t);
  const owner = await f.connect(); const room = await owner.create();
  owner.send({ type: 'leave' });
  await owner.create('新房间'); // 同一连接的排队操作是离开已处理完的同步屏障。
  const guest = await f.connect();
  guest.send({ type: 'join', roomId: room.roomId, name: '访客', password });
  assert.equal((await guest.next('error')).code, 'JOIN_DENIED');
});

test('麦克风状态广播并进入后来加入者的成员列表', async t => {
  const f = await fixture(t);
  const owner = await f.connect(); const room = await owner.create();
  owner.send({ type: 'mic', active: true });
  assert.deepEqual(await owner.next('peer-state'), { type: 'peer-state', peerId: room.selfId, mic: true });
  const guest = await f.connect();
  assert.equal((await guest.join(room.roomId)).peers[0].mic, true);
  owner.send({ type: 'mic', active: 'true' });
  assert.equal((await owner.next('error')).code, 'BAD_MESSAGE');
});

test('非法 JSON、二进制、消息和信令被拒绝，连接仍可用于有效操作', async t => {
  const f = await fixture(t);
  const owner = await f.connect();
  for (const invalid of ['not-json', 'null', '[]']) {
    owner.ws.send(invalid);
    assert.equal((await owner.next('error')).code, 'BAD_MESSAGE');
  }
  owner.ws.send(Buffer.from('hello'));
  assert.equal((await owner.next('error')).code, 'BAD_MESSAGE');
  owner.send({ type: 'present', active: true });
  assert.equal((await owner.next('error')).code, 'NOT_JOINED');
  owner.send({ type: 'create', name: 'x', password: 'short' });
  assert.equal((await owner.next('error')).code, 'BAD_PASSWORD');
  owner.send({ type: 'create', name: 'x\ny', password });
  assert.equal((await owner.next('error')).code, 'BAD_NAME');
  owner.send({ type: 'create', name: 'x\n', password });
  // 边缘空白会被清理，内部控制字符才属于无效昵称。
  const room = await owner.next('joined');
  const guest = await f.connect(); const guestInfo = await guest.join(room.roomId);
  const invalidSignals = [
    null, {}, { description: { type: 'rollback', sdp: '' } },
    { description: { type: 'offer', sdp: 'v=0' }, candidate: null },
    { candidate: { candidate: 'candidate:0', sdpMLineIndex: -1 } },
    { candidate: { candidate: 'x'.repeat(4097) } },
  ];
  for (const payload of invalidSignals) {
    owner.send({ type: 'signal', to: guestInfo.selfId, payload });
    assert.equal((await owner.next('error')).code, 'BAD_SIGNAL');
  }
  owner.send({ type: 'mic', active: true });
  assert.equal((await guest.next('peer-state')).mic, true);
});

test('HTTP 与 WebSocket 拒绝非允许 Host、Origin 和路径', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/healthz', { headers: { Host: 'evil.example' } })).status, 421);
  assert.equal(await f.rejectedUpgrade({ Origin: 'https://evil.example' }), 403);
  assert.equal(await f.rejectedUpgrade({ Origin: '' }), 403);
  assert.equal(await f.rejectedUpgrade({ Host: 'evil.example' }), 403);
  assert.equal(await f.rejectedUpgrade({}, '/ws?unrecognized=1'), 403);
  const healthy = await f.request('/healthz');
  assert.deepEqual(JSON.parse(healthy.body), { ok: true });
  assert.equal(healthy.headers['x-content-type-options'], 'nosniff');
  assert.equal(healthy.headers['x-frame-options'], 'DENY');
});

test('静态路径白名单不泄漏 .env、服务代码、依赖或越界文件', async t => {
  const f = await fixture(t);
  for (const path of ['/.env', '/server.mjs', '/package.json', '/node_modules/ws/package.json', '/..%2f.env', '/%2e%2e/.env']) {
    assert.equal((await f.request(path)).status, 404, path);
  }
  assert.equal((await f.request('/api/config', { method: 'POST' })).status, 405);
  const head = await f.request('/healthz', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.body, '');
});

test('站点口令保护创建与加入；配置不暴露口令或 TURN 主密钥', async t => {
  const siteKey = 'private-instance-access-key';
  const turnSecret = 'turn-secret-for-tests-only-32-chars-minimum';
  const f = await fixture(t, {
    PUBLIC_ORIGIN: 'https://screen.example.test', SITE_ACCESS_KEY: siteKey,
    STUN_URLS: 'stun:turn.example.test:3478', TURN_URLS: 'turn:turn.example.test:3478?transport=udp,turns:turn.example.test:5349?transport=tcp',
    TURN_SECRET: turnSecret, ICE_RELAY_ONLY: 'true',
  });
  const config = await f.request('/api/config');
  assert.equal(config.status, 200);
  assert.deepEqual(JSON.parse(config.body), {
    maxParticipants: 6, publicOrigin: 'https://screen.example.test', hasTurn: true,
    icePolicy: 'relay', requiresAccessKey: true,
  });
  assert.equal(config.body.includes(siteKey), false); assert.equal(config.body.includes(turnSecret), false);
  assert.match(config.headers['strict-transport-security'], /max-age=/);
  const owner = await f.connect();
  owner.send({ type: 'create', name: '房主', password });
  assert.equal((await owner.next('error')).code, 'ACCESS_DENIED');
  owner.send({ type: 'create', name: '房主', password, accessKey: 'wrong' });
  assert.equal((await owner.next('error')).code, 'ACCESS_DENIED');
  const room = await owner.create('房主', { accessKey: siteKey });
  assert.equal(room.iceTransportPolicy, 'relay');
  assert.equal(room.iceServers.length, 2);
  const turn = room.iceServers[1];
  const [expiry, peerId] = [Number(turn.username.split(':')[0]), turn.username.slice(turn.username.indexOf(':') + 1)];
  assert.equal(peerId, room.selfId);
  assert.ok(Math.abs(expiry - Math.floor(Date.now() / 1000) - 86400) <= 2);
  assert.equal(turn.credential, createHmac('sha1', turnSecret).update(turn.username).digest('base64'));
  assert.equal(JSON.stringify(room).includes(turnSecret), false);
  assert.equal(JSON.stringify(room).includes(siteKey), false);
  const guest = await f.connect();
  guest.send({ type: 'join', roomId: room.roomId, name: '朋友', password });
  assert.equal((await guest.next('error')).code, 'ACCESS_DENIED');
  const joined = await guest.join(room.roomId, '朋友', { accessKey: siteKey });
  assert.notEqual(joined.iceServers[1].username, turn.username);
});
