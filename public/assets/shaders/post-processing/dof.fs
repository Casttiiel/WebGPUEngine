#include "common/uniforms"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// G-Buffer textures
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

// DOF Textures: Original, Near blur, Far blur, CoC
@group(2) @binding(0) var originalTexture: texture_2d<f32>;
@group(2) @binding(1) var nearBlurTexture: texture_2d<f32>;
@group(2) @binding(2) var farBlurTexture: texture_2d<f32>;
@group(2) @binding(3) var cocTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let original = textureSample(originalTexture, samplerGBuffer, uv);
    let nearBlur = textureSample(nearBlurTexture, samplerGBuffer, uv);
    let farBlur = textureSample(farBlurTexture, samplerGBuffer, uv);
    let cocData = textureSample(cocTexture, samplerGBuffer, uv);
    
    let farCoC = cocData.r;   // Background blur amount
    let nearCoC = cocData.g;  // Foreground blur amount
    let fullCoC = cocData.b;  // Signed CoC
    
    var result: vec4<f32>;
    
    // Skybox detection (CoC = 0 siempre)
    let linearDepth = textureSample(gLinearDepth, samplerGBuffer, uv).r;
    if (linearDepth >= 0.9999) {
        return original; // Skybox siempre sharp
    }
    
    // Decisión de composición basada en CoC
    if (abs(fullCoC) < 0.5) {
        // In focus - usar imagen original
        result = original;
    } else if (fullCoC < 0.0) {
        // Near blur (foreground)
        let blendFactor = smoothstep(0.0, 10.0, nearCoC);
        result = mix(original, nearBlur, blendFactor);
    } else {
        // Far blur (background)
        let blendFactor = smoothstep(0.0, 10.0, farCoC);
        result = mix(original, farBlur, blendFactor);
    }
    
    return result;
}