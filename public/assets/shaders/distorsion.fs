#include "common/uniforms"
#include "common/structs"
#include "common/utils"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var txAlbedo: texture_2d<f32>;
@group(1) @binding(1) var txNormal: texture_2d<f32>;
@group(1) @binding(2) var txMetallic: texture_2d<f32>;
@group(1) @binding(3) var txRoughness: texture_2d<f32>;
@group(1) @binding(4) var txEmissive: texture_2d<f32>;
@group(1) @binding(5) var samplerState: sampler;
@group(3) @binding(0) var accLight: texture_2d<f32>;
@group(3) @binding(1) var samplerLight: sampler;

@fragment
fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
    // Distorsion strength (could be a uniform parameter)
    let distortionStrength = 0.2;
    
    // Calculate position displaced by normal in world space
    let displacedWorldPos = input.WorldPos.xyz + (input.N.xyz * distortionStrength);
    
    // Project displaced position to screen space
    let displacedClipPos = camera.projectionMatrix * camera.viewMatrix * vec4<f32>(displacedWorldPos, 1.0);
    let displacedNDC = displacedClipPos.xy / displacedClipPos.w;

    var uv = displacedNDC * 0.5 + vec2<f32>(0.5, 0.5); // Convert to [0,1] for texture sampling
    uv.y = 1.0 - uv.y; // Flip Y for texture coordinates
    let color = textureSample(accLight, samplerLight, uv);
    
    // Output distortion vector in RG channels, usar B para refraction strength
    // R = deltaX, G = deltaY en coordenadas NDC, B = refraction strength
    return vec4<f32>(color.xyz, 1.0);
}