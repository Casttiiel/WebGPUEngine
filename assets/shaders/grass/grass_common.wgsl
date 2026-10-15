// ---------------------------------------------------------------------------
// Shared grass shader declarations: GrassUniforms struct + Bayer dithering.
// // ---------------------------------------------------------------------------
// Shared grass shader declarations: GrassUniforms struct + Bayer dithering.
//  in any grass shader that needs LOD or wind.
// ---------------------------------------------------------------------------

struct GrassUniforms {
  windDir:          vec2<f32>,  // offset  0 — normalised XZ wind direction
  windSpeed:        f32,        // offset  8 — overall speed / amplitude scale
  wiggleIntensity:  f32,        // offset 12 — Phase 1: max chaotic XZ wiggle (m)
  wiggleFrequency:  f32,        // offset 16 — Phase 1: spatial frequency
  swayIntensity:    f32,        // offset 20 — Phase 2: max directional sway (m)
  swayFrequency:    f32,        // offset 24 — Phase 2: oscillation rate
  gustFrequency:    f32,        // offset 28 — Phase 3: spatial stripe frequency
  gustSpeed:        f32,        // offset 32 — Phase 3: stripe travel speed
  gustIntensity:    f32,        // offset 36 — Phase 3: amplitude multiplier at gust peak
  lodNearFadeStart: f32,        // offset 40 — distance where near LOD begins fading out
  lodNearFadeEnd:   f32,        // offset 44 — distance where near LOD is fully gone
  lodFarFadeStart:  f32,        // offset 48 — distance where billboard begins fading in
  lodFarFadeEnd:    f32,        // offset 52 — distance where billboard is fully gone
  // struct size 56 bytes, AlignOf 8 → GPU buffer allocated as 64 bytes
}

// ---------------------------------------------------------------------------
// Bayer 4×4 ordered-dithering threshold for distance-based LOD transitions.
// pos: screen-space pixel coordinates (input.position.xy in a fragment shader).
// Returns a value in [0, 1).
// Usage:  if fadeRatio > bayer4x4(pos) { discard; }
//   fadeRatio = 0  → never discard (fully visible)
//   fadeRatio = 1  → always discard (fully invisible)
// ---------------------------------------------------------------------------
fn bayer4x4(pos: vec2<f32>) -> f32 {
  let bayer = array<u32, 16>(
     0u,  8u,  2u, 10u,
    12u,  4u, 14u,  6u,
     3u, 11u,  1u,  9u,
    15u,  7u, 13u,  5u
  );
  let ix = u32(pos.x) % 4u;
  let iy = u32(pos.y) % 4u;
  return f32(bayer[ix + iy * 4u]) / 16.0;
}
 in any grass shader that needs LOD or wind.
// ---------------------------------------------------------------------------

struct GrassUniforms {
  windDir:          vec2<f32>,  // offset  0 — normalised XZ wind direction
  windSpeed:        f32,        // offset  8 — overall speed / amplitude scale
  wiggleIntensity:  f32,        // offset 12 — Phase 1: max chaotic XZ wiggle (m)
  wiggleFrequency:  f32,        // offset 16 — Phase 1: spatial frequency
  swayIntensity:    f32,        // offset 20 — Phase 2: max directional sway (m)
  swayFrequency:    f32,        // offset 24 — Phase 2: oscillation rate
  gustFrequency:    f32,        // offset 28 — Phase 3: spatial stripe frequency
  gustSpeed:        f32,        // offset 32 — Phase 3: stripe travel speed
  gustIntensity:    f32,        // offset 36 — Phase 3: amplitude multiplier at gust peak
  lodNearFadeStart: f32,        // offset 40 — distance where near LOD begins fading out
  lodNearFadeEnd:   f32,        // offset 44 — distance where near LOD is fully gone
  lodFarFadeStart:  f32,        // offset 48 — distance where billboard begins fading in
  lodFarFadeEnd:    f32,        // offset 52 — distance where billboard is fully gone
  // struct size 56 bytes, AlignOf 8 → GPU buffer allocated as 64 bytes
}

// ---------------------------------------------------------------------------
// Bayer 4×4 ordered-dithering threshold for distance-based LOD transitions.
// pos: screen-space pixel coordinates (input.position.xy in a fragment shader).
// Returns a value in [0, 1).
// Usage:  if fadeRatio > bayer4x4(pos) { discard; }
//   fadeRatio = 0  → never discard (fully visible)
//   fadeRatio = 1  → always discard (fully invisible)
// ---------------------------------------------------------------------------
fn bayer4x4(pos: vec2<f32>) -> f32 {
  let bayer = array<u32, 16>(
     0u,  8u,  2u, 10u,
    12u,  4u, 14u,  6u,
     3u, 11u,  1u,  9u,
    15u,  7u, 13u,  5u
  );
  let ix = u32(pos.x) % 4u;
  let iy = u32(pos.y) % 4u;
  return f32(bayer[ix + iy * 4u]) / 16.0;
}
