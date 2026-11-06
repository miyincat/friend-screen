import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingSignals } from '../public/pending-signals.js';

test('早到信令按peer独立保序，drain和清理会释放容量', () => {
  const pending = new PendingSignals({ maxPeers: 2, maxPerPeer: 3, maxTotal: 5 });
  const offer = { description: { type: 'offer', sdp: 'offer' } };
  const firstIce = { candidate: { candidate: 'candidate:first' } };
  const secondIce = { candidate: { candidate: 'candidate:second' } };

  assert.equal(pending.enqueue('peer-a', offer), true);
  assert.equal(pending.enqueue('peer-b', firstIce), true);
  assert.equal(pending.enqueue('peer-a', firstIce), true);
  assert.equal(pending.enqueue('peer-a', secondIce), true);
  assert.equal(pending.size, 4);
  assert.deepEqual(pending.drain('peer-a'), [offer, firstIce, secondIce]);
  assert.equal(pending.size, 1);
  assert.deepEqual(pending.drain('peer-a'), []);
  pending.delete('peer-b');
  assert.equal(pending.size, 0);
  assert.equal(pending.queues.size, 0);
});

test('达到上限时只淘汰旧ICE来保留描述，拒绝无法安全容纳的信令', () => {
  const pending = new PendingSignals({ maxPeers: 2, maxPerPeer: 2, maxTotal: 3 });
  const ice = value => ({ candidate: { candidate: `candidate:${value}` } });
  const offer = value => ({ description: { type: 'offer', sdp: value } });

  assert.equal(pending.enqueue('peer-a', ice('old')), true);
  assert.equal(pending.enqueue('peer-a', offer('first')), true);
  assert.equal(pending.enqueue('peer-a', offer('second')), true);
  assert.deepEqual(pending.drain('peer-a'), [offer('first'), offer('second')]);

  pending.enqueue('peer-a', offer('kept'));
  pending.enqueue('peer-b', offer('also-kept'));
  assert.equal(pending.enqueue('peer-c', offer('over-peer-limit')), false);
  assert.equal(pending.enqueue('peer-b', ice('over-peer-limit')), true);
  assert.equal(pending.enqueue('peer-b', ice('over-peer-limit')), false);
  assert.equal(pending.enqueue('peer-a', offer('over-total-limit')), true);
  assert.equal(pending.size, 3);
  assert.deepEqual(pending.drain('peer-b'), [offer('also-kept')]);
  assert.deepEqual(pending.drain('peer-a'), [offer('kept'), offer('over-total-limit')]);
  pending.clear();
  assert.equal(pending.size, 0);
  assert.equal(pending.queues.size, 0);
});

test('拒绝无效peer、无效载荷和同时包含description与candidate的载荷', () => {
  const pending = new PendingSignals();
  assert.equal(pending.enqueue('', { candidate: null }), false);
  assert.equal(pending.enqueue('peer', null), false);
  assert.equal(pending.enqueue('peer', { description: {}, candidate: null }), false);
  assert.equal(pending.size, 0);
  assert.equal(pending.enqueue('peer', { candidate: null }), true);
  pending.clear();
  assert.equal(pending.size, 0);
});
