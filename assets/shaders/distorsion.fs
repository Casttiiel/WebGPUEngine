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
    let distortionStrength = 0.05;
    
    // Calculate position displaced by normal in world space
    let displacedWorldPos = input.WorldPos.xyz + input.N.xyz * distortionStrength;
    
    // Project displaced position to screen space
    let displacedClipPos = camera.projectionMatrix * camera.viewMatrix * vec4<f32>(displacedWorldPos, 1.0);
    let displacedNDC = displacedClipPos.xyz / displacedClipPos.w;
    
    // Convert current position to NDC
    let currentNDC = input.position.xyz / input.position.w;
    
    // Calculate distortion vector in screen space
    let distortionVector = displacedNDC.xy - currentNDC.xy;
    
    // Output distortion as RG channels (XY displacement)
    // Scale and bias to [0,1] range for storage in texture
    if(input.position.x > 0.0) {
        return vec4<f32>(1.0, 0.0,0.0, 1.0);
    } else {
        return vec4<f32>(0.0, 1.0, 0.0,1.0);
    }
    return vec4<f32>(distortionVector * 0.5 + 0.5, 0.0, 1.0);
}