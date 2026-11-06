import { _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { once } from 'node:events';

const root = process.cwd();
const version = JSON.parse(await fs.readFile('package.json', 'utf8')).version;
const release = path.join(root, 'dist', version);
const resources = path.join(release, 'win-unpacked', 'resources');
const manifest = await fs.readFile(path.join(release, 'latest.yml'));
const info = JSON.parse(manifest);
const installer = path.join(release, info.path);
const requests = [];
const server = createServer((request, response) => {
  const target = new URL(request.url, 'http://127.0.0.1').pathname;
  requests.push(target);
  if (target === '/latest.yml') {
    response.writeHead(200, { 'Content-Type': 'text/yaml', 'Content-Length': manifest.length });
    response.end(manifest);
  } else if (target === '/' + info.path) {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': info.files[0].size });
    createReadStream(installer).pipe(response);
  } else {
    response.writeHead(404);
    response.end();
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let app;
const data = await fs.mkdtemp(path.join(root, 'artifacts', 'download-fixture-'));
try {
  app = await electron.launch({
    args: ['test/update-download-shell.cjs'],
    cwd: root,
    env: {
      ...process.env,
      FRIEND_TEST_UPDATE_DATA: data,
      FRIEND_TEST_UPDATE_RESOURCES: resources,
      FRIEND_TEST_UPDATE_ORIGIN: 'http://127.0.0.1:' + server.address().port,
    },
  });
  await app.firstWindow();
  const result = await app.evaluate(() => globalThis.downloadFixtureUpdate());
  assert.equal(result.checked.phase, 'available', JSON.stringify(result.checked));
  assert.equal(result.checked.version, version);
  assert.equal(result.downloaded.phase, 'ready', JSON.stringify(result.downloaded));
  assert.equal(result.downloaded.progress, 100);
  assert.deepEqual(requests, ['/latest.yml', '/' + info.path]);
  console.log('PASS: signed manifest and complete NSIS download using the Electron updater');
} finally {
  await app?.close().catch(() => {});
  await new Promise(resolve => server.close(resolve));
  const resolved = await fs.realpath(data);
  assert.equal(path.dirname(resolved), await fs.realpath(path.join(root, 'artifacts')));
  assert.match(path.basename(resolved), /^download-fixture-/);
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 4 });
}
