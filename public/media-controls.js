export const PLAYBACK_TARGETS = Object.freeze({ realtime: null, smooth: 600 });

// Leave capacity for shared sound, repair, pacing and the room microphones.
// This is an encoder budget; actual wire traffic still belongs to WebRTC.
export function videoBudget(requested, totalUpload, children) {
  if (!Number.isFinite(requested) || requested < 500000) throw new TypeError('Invalid video ceiling');
  if (!Number.isFinite(totalUpload) || totalUpload < 2000000) throw new TypeError('Invalid upload budget');
  if (!Number.isInteger(children) || children < 0 || children > 2) throw new TypeError('Invalid child count');
  return Math.max(500000, Math.min(requested, Math.floor(totalUpload * 0.75 / Math.max(1, children))));
}

export function setPlaybackTarget(pc, mode, own = false) {
  if (!Object.hasOwn(PLAYBACK_TARGETS, mode)) throw new TypeError('Invalid playback mode');
  const target = own ? null : PLAYBACK_TARGETS[mode];
  const receivers = pc.getReceivers().filter(receiver => receiver.track && ['video', 'audio'].includes(receiver.track.kind));
  let supported = receivers.length > 0;
  for (const receiver of receivers) {
    if (!('jitterBufferTarget' in receiver)) { supported = false; continue; }
    try { receiver.jitterBufferTarget = target; } catch { supported = false; }
  }
  return { targetMs: target, supported };
}
