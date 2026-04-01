#include "common/uniforms"

/**
 * Velocity Buffer Fragment Shader
 * 
 * Genera motion vectors (velocidad en screen space) comparando:
 * - Posición actual del píxel (current frame)
 * - Posición reproyectada usando previous ViewProjection matrix
 * 
 * Output: vec2(velocityX, velocityY) en RG16Float texture
 */

// Previous frame ViewProjection matrix
@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;
// @group(2) — Unjittered matrices for velocity generation.
// Using unjittered matrices on BOTH sides ensures that for a perfectly static scene with
// a static camera the velocity is exactly zero, even when camera jitter is active.
// Using the jittered VP (from CameraUniforms) for reconstruction causes the jitter-sign
// alternation (A→B→A→B each frame) to produce a non-zero oscillating velocity → vibration.
@group(2) @binding(0) var<uniform> previousUnjitteredVP:   mat4x4<f32>; // prev frame unjittered VP
@group(2) @binding(1) var<uniform> currentUnjitteredInvVP: mat4x4<f32>; // current frame unjittered inv VP

struct VertexOutput {
    @builtin(position) Position: vec4<f32>,
    @location(0) Uv: vec2<f32>,
};

@fragment
fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
    // 1. Sample depth del frame actual
    let depth = textureSample(gLinearDepth, samplerGBuffer, input.Uv).x;
    
    // Early exit si es skybox (depth = 1.0)
    if (depth >= 0.9999) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }
    
    // 2. Reconstruir posición world del frame actual usando unjittered inv VP.
    // IMPORTANTE: NO usar camera.invViewProjection aquí — ese tiene el jitter del frame actual
    // incorporado. El jitter alterna signo cada frame, por lo que worldPos oscilaría
    // ligeramente cada frame → velocity oscila → vibración de cámara.
    let ndcX = input.Uv.x * 2.0 - 1.0;
    let ndcY = (1.0 - input.Uv.y) * 2.0 - 1.0; // Invertir Y (texture UV vs NDC)
    let ndcZ = depth;
    let ndcW = 1.0;
    
    let clipSpacePos = vec4<f32>(ndcX, ndcY, ndcZ, ndcW);
    
    var worldPos = currentUnjitteredInvVP * clipSpacePos;
    worldPos = worldPos / worldPos.w;
    
    // 3. Reproyectar world position usando previousUnjitteredVP.
    // Static camera + static scene → prevNDC == currentNDC → velocity = 0 ✓
    let previousClipSpace = previousUnjitteredVP * worldPos;
    var previousNDC = previousClipSpace.xyz / previousClipSpace.w;
    
    // 4. Convertir previous NDC a UV coordinates
    let previousUV = vec2<f32>(
        previousNDC.x * 0.5 + 0.5,
        1.0 - (previousNDC.y * 0.5 + 0.5) // Invertir Y de vuelta a UV space
    );
    
    // 5. Calcular velocity (diferencia entre current y previous UV)
    let velocity = input.Uv - previousUV;
    
    // 6. Escalar velocity a píxeles (opcional, para visualización/debug)
    // let resolution = vec2<f32>(1920.0, 1080.0); // TODO: pasar como uniform
    // let velocityPixels = velocity * resolution;
    
    // Output: velocity en RG, BA sin usar (0.0, 0.0)
    // Positivo = objeto se mueve hacia abajo/derecha
    // Negativo = objeto se mueve hacia arriba/izquierda
    return vec4<f32>(velocity.x, velocity.y, 0.0, 0.0);
}
