export class PendingSignals {
  constructor({ maxPeers = 8, maxPerPeer = 64, maxTotal = 256 } = {}) {
    if (![maxPeers, maxPerPeer, maxTotal].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new TypeError('Signal queue limits must be positive integers');
    }
    this.maxPeers = maxPeers;
    this.maxPerPeer = maxPerPeer;
    this.maxTotal = maxTotal;
    this.queues = new Map();
    this.size = 0;
  }

  enqueue(peerId, payload) {
    if (typeof peerId !== 'string' || !peerId || peerId.length > 128 ||
        !payload || typeof payload !== 'object' || Array.isArray(payload) ||
        Object.hasOwn(payload, 'description') === Object.hasOwn(payload, 'candidate')) return false;

    let queue = this.queues.get(peerId);
    while (!queue && this.queues.size >= this.maxPeers) {
      if (!this.dropOldestCandidate()) return false;
      queue = this.queues.get(peerId);
    }

    queue = this.queues.get(peerId);
    if (!queue) this.queues.set(peerId, queue = []);

    while (queue.length >= this.maxPerPeer) {
      if (!Object.hasOwn(payload, 'description') || !this.dropOldestCandidate(peerId)) return false;
      queue = this.queues.get(peerId) || [];
      if (!this.queues.has(peerId)) this.queues.set(peerId, queue);
    }
    while (this.size >= this.maxTotal) {
      if (!this.dropOldestCandidate()) return false;
      queue = this.queues.get(peerId) || [];
      if (!this.queues.has(peerId)) this.queues.set(peerId, queue);
    }

    queue.push(payload);
    this.size++;
    return true;
  }

  drain(peerId) {
    const queue = this.queues.get(peerId);
    if (!queue) return [];
    this.queues.delete(peerId);
    this.size -= queue.length;
    return queue;
  }

  delete(peerId) {
    const queue = this.queues.get(peerId);
    if (!queue) return;
    this.queues.delete(peerId);
    this.size -= queue.length;
  }

  clear() {
    this.queues.clear();
    this.size = 0;
  }

  dropOldestCandidate(peerId) {
    const queues = peerId === undefined
      ? this.queues.entries()
      : [[peerId, this.queues.get(peerId) || []]];
    for (const [id, queue] of queues) {
      const index = queue.findIndex(payload => Object.hasOwn(payload, 'candidate'));
      if (index < 0) continue;
      queue.splice(index, 1);
      this.size--;
      if (!queue.length) this.queues.delete(id);
      return true;
    }
    return false;
  }
}
