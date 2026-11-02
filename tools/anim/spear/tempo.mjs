// Tempo profiles: the same attack retimed for a different attacker/weapon. Each key's `phase`
// tags the segment that ends at it; a profile stretches each phase on its own, because weight
// and agility do not slow everything equally — a heavy fighter loads longer, holds longer and
// recovers much longer, while the strike itself stays relatively fast.
// Timing only: weight also shows in poses (bigger follow-through, the weapon dragging the body),
// which belongs in the keys themselves.

export const TEMPOS = {
  /** As authored: light spear, agile fighter (Kaladin). */
  agile: { antic: 1, strike: 1, hold: 1, recover: 1 },
  /** Heavier weapon / slower fighter. */
  heavy: { antic: 1.6, strike: 1.35, hold: 1.5, recover: 1.7 },
  /** As authored, for sets whose authored timing already is the weapon's own (greatsword). */
  base: { antic: 1, strike: 1, hold: 1, recover: 1 },
};

/** Returns the clip with its keys and events retimed by the profile. */
export function retime(clip, profile) {
  const map = [[0, 0]];
  const keys = clip.keys.map((k, i) => {
    if (i === 0) return { ...k };
    const prev = clip.keys[i - 1];
    const scale = profile[k.phase] ?? 1;
    const t = map[map.length - 1][1] + (k.t - prev.t) * scale;
    map.push([k.t, t]);
    return { ...k, t: Math.round(t * 1000) / 1000 };
  });
  const remap = (t) => {
    let i = 0;
    while (i < map.length - 2 && t > map[i + 1][0]) i++;
    const [a0, b0] = map[i], [a1, b1] = map[i + 1];
    return Math.round((b0 + ((t - a0) / (a1 - a0)) * (b1 - b0)) * 1000) / 1000;
  };
  const events = { ...clip.events, hit: remap(clip.events.hit), cancel: remap(clip.events.cancel) };
  if (clip.events.entry !== undefined) events.entry = remap(clip.events.entry);
  return { ...clip, keys, events };
}
