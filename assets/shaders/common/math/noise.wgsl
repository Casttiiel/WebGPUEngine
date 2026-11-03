// Noise and hash functions for procedural generation
// Level 1: Depends on core/constants

// Mathematical constants used throughout shaders
// Level 0: No dependencies

const PI: f32 = 3.14159265359;
const TWO_PI: f32 = 6.28318530718;
const HALF_PI: f32 = 1.57079632679;
const INV_PI: f32 = 0.31830988618;
const EPSILON: f32 = 0.0001;


// Simple 2D noise function
fn noise2D(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}

// 2D hash function - returns vec2 for varied randomness
fn hash2(p: f32) -> vec2<f32> {
    let n = sin(p * 12.9898 + 78.233) * 43758.5453;
    return fract(vec2<f32>(n, n * 1.3));
}

// 3D hash function - single float output
fn hash3(p: vec3<f32>) -> f32 {
    return fract(sin(dot(p, vec3<f32>(12.9898, 78.233, 37.719))) * 43758.5453);
}
