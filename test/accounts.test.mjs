import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApp, readConfig } from '../server.mjs';

test('账号注册、资料、会话持久化、身份绑定、退出及来源校验', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'friend-accounts-'));
  let app, base, cookie = '', socket;
  async function start() { app = createApp(readConfig({ PORT: '0', ACCOUNT_DATA_DIR: dataDir })); base = `http://127.0.0.1:${await app.listen()}`; }
  async function api(route, data, custom = {}) {
    const res = await fetch(base + '/api/account' + route, { method: data === undefined ? 'GET' : 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', Cookie: cookie, ...custom }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie') };
  }
  try {
    await start();
    assert.equal((await api('')).body.user, null);
    const input = { username: 'room_friend', name: '我的朋友', password: 'account-test-password', remember: true };
    assert.equal((await api('/register', input, { Origin: 'https://foreign.example' })).status, 403);
    const registration = await api('/register', input);
    assert.equal(registration.status, 200);
    assert.match(registration.cookie, /HttpOnly; SameSite=Strict; Max-Age=2592000/);
    cookie = registration.cookie.split(';')[0];
    assert.equal((await api('')).body.user.username, 'room_friend');
    assert.equal((await api('/register', input)).status, 409);
    assert.equal((await api('/login', { ...input, password: 'wrong-password' })).status, 401);
    assert.equal((await api('/profile', { name: '新昵称', avatar: 'data:image/svg+xml;base64,PHN2Zz4=', micVolume: 100 })).status, 400);
    assert.equal((await api('/profile', { name: '新昵称', avatar: '', micVolume: 201 })).status, 400);
    assert.equal((await api('/profile', { name: '新昵称', avatar: '', micVolume: 65 })).status, 200);
    const disk = await readFile(path.join(dataDir, 'accounts.json'), 'utf8');
    assert.ok(!disk.includes(input.password)); assert.ok(!disk.includes(cookie.split('=')[1]));
    await app.close(); await start();
    assert.equal((await api('')).body.user.name, '新昵称');
    assert.equal((await api('')).body.user.micVolume, 65);
    socket = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { Origin: base, Cookie: cookie } });
    await once(socket, 'open');
    const first = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'create', name: '伪造名字', password: 'room-password' }));
    const room = JSON.parse((await first)[0]); assert.equal(room.type, 'joined');
    const profileEvent = once(socket, 'message');
    await api('/profile', { name: '账号真实昵称', avatar: '', micVolume: 65 });
    assert.equal(JSON.parse((await profileEvent)[0]).name, '账号真实昵称');
    const invalid = once(socket, 'message'); socket.send(JSON.stringify({ type: 'profile', avatar: '' }));
    assert.equal(JSON.parse((await invalid)[0]).code, 'BAD_PROFILE');
    const closed = once(socket, 'close');
    assert.equal((await api('/logout', {})).status, 200); await closed;
    assert.equal((await api('')).body.user, null);
    assert.equal((await api('/profile', { name: '坏人', avatar: '', micVolume: 100 })).status, 401);
    const temporary = await api('/login', { ...input, remember: false });
    assert.equal(temporary.status, 200); assert.ok(!temporary.cookie.includes('Max-Age'));
  } finally { socket?.terminate(); await app?.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('登录尝试限流，资料请求大小受限', async () => {
  const app = createApp(readConfig({ PORT: '0', ACCOUNT_DATA_DIR: ':memory:' }));
  const base = `http://127.0.0.1:${await app.listen()}`;
  try {
    let status;
    for (let i = 0; i < 16; i++) {
      const res = await fetch(base + '/api/account/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'nonexistent', password: 'wrong-password' }) });
      status = res.status; await res.text();
    }
    assert.equal(status, 429);
    const oversized = await fetch(base + '/api/account/profile', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ avatar: 'x'.repeat(41000) }) });
    assert.equal(oversized.status, 413);
  } finally { await app.close(); }
});
