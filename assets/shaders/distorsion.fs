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
    let displacedNDC = displacedClipPos.xy / displacedClipPos.w;
    
    // Current position is already in NDC after perspective divide
    let currentNDC = input.position.xy;
    
    // Calculate distortion vector in NDC space [-1,1]
    let distortionVector = displacedNDC - currentNDC;
    if(currentNDC.x > 0.0) {
        return vec4<f32>(1.0, 0.0,0.0, 1.0);
    } else {
        return vec4<f32>(0.0, 1.0, 0.0,1.0);
    }
    // Output distortion as RG channels (XY displacement in NDC)
    // NO scaling to [0,1] - necesitamos mantener valores negativos
    // R = deltaX, G = deltaY en coordenadas NDC
    //return vec4<f32>(distortionVector, 0.0, 1.0);
}