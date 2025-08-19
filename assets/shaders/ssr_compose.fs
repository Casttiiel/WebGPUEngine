#include "common/uniforms"
#include "common/structs"

@group(0) @binding(0) var sceneTexture: texture_2d<f32>;
@group(0) @binding(1) var sceneSampler: sampler;

@group(1) @binding(0) var ssrTexture: texture_2d<f32>;
@group(1) @binding(1) var ssrSampler: sampler;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    // Sample both textures
    let sceneColor = textureSample(sceneTexture, sceneSampler, uv);
    let ssrColor = textureSample(ssrTexture, ssrSampler, uv);
    
    // Additive blending: scene + reflections
    let finalColor = sceneColor.rgb + ssrColor.rgb * ssrColor.a;
    
    return vec4<f32>(finalColor, sceneColor.a);
}
