import { randomUUID } from 'node:crypto';

// A conservative two-child policy keeps each member's upload bounded.
// Piik forwards compressed media, rather than encoding once per viewer.
export function buildMediaTree(ids, presenter, old = []) {
  if (!presenter || !ids.includes(presenter)) return [];
  const nodes = [presenter, ...ids.filter(id => id !== presenter)];
  return nodes.slice(1).map((to, offset) => {
    const from = nodes[Math.floor(offset / 2)];
    return old.find(e => e.from === from && e.to === to) || { from, to, connectionId: randomUUID() };
  });
}
export function isMediaRoute(edges, from, to, connectionId) {
  return edges.some(e => e.connectionId === connectionId && ((e.from === from && e.to === to) || (e.from === to && e.to === from)));
}
