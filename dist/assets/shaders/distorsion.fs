#include "common/uniforms"
#include "common/structs"
#include "common/utils"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(2) @binding(0) var txAlbedo: texture_2d<f32>;
@group(2) @binding(1) var txNormal: texture_2d<f32>;
@group(2) @binding(2) var txMetallic: texture_2d<f32>;
@group(2) @binding(3) var txRoughness: texture_2d<f32>;
@group(2) @binding(4) var txEmissive: texture_2d<f32>;
@group(2) @binding(5) var samplerState: sampler;

@fragment
fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
    // Distorsion strength (could be a uniform parameter)
    let distortionStrength = 1.0;
    
    // Calculate position displaced by normal in world space
    let displacedWorldPos = input.WorldPos.xyz + (input.N.xyz * distortionStrength);
    
    // Project displaced position to screen space
    let displacedClipPos = camera.projectionMatrix * camera.viewMatrix * vec4<f32>(displacedWorldPos, 1.0);
    let displacedNDC = displacedClipPos.xy / displacedClipPos.w;

    let clipPos = camera.projectionMatrix * camera.viewMatrix * vec4<f32>(input.WorldPos.xyz, 1.0);
    let currentNDC = clipPos.xy / clipPos.w;
    
    // Calculate distortion vector in NDC space [-1,1]
    let distortionVector = displacedNDC - currentNDC;
    
    // Output distortion vector in RG channels, usar B para refraction strength
    // R = deltaX, G = deltaY en coordenadas NDC, B = refraction strength
    return vec4<f32>(distortionVector.x, distortionVector.y, 0.0, 1.0);
}