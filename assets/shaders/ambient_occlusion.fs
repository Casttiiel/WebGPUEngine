#include "common/uniforms"
#include "common/structs"
#include "common/utils"

struct GBuffer {
    worldPos: vec3<f32>,
    normal: vec3<f32>,
    albedo: vec3<f32>,
    specularColor: vec3<f32>,
    roughness: f32,
    selfIllum: vec3<f32>,
    emissive: f32,
    reflectedDir: vec3<f32>,
    viewDir: vec3<f32>,
    metallic: f32,
    zlinear: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var gSelfIllum: texture_2d<f32>;
@group(1) @binding(4) var gAO: texture_2d<f32>;
@group(1) @binding(5) var samplerGBuffer: sampler;


fn decodeGBuffer(uv: vec2<f32>) -> GBuffer {
    var g: GBuffer;
    
    // Get linear depth and world position
    let zlinear = textureSample(gLinearDepth, samplerGBuffer, uv).x;
    g.zlinear = zlinear;
    g.worldPos = getWorldCoords(uv, zlinear, camera);
    
    // Get normal
    let normalData = textureSample(gNormals, samplerGBuffer, uv);
    g.normal = normalize(decodeNormal(normalData.xyz));
    
    // Get albedo and metallic
    let albedo = textureSample(gAlbedo, samplerGBuffer, uv);
    g.metallic = albedo.a;
    g.roughness = normalData.a;
    g.metallic = max(clamp(1.0 - normalData.a, 0.0, 1.0), g.metallic);
    
    // Gamma correction for albedo
    let albedoLinear = pow(abs(albedo.rgb), vec3<f32>(2.2));
    
    // Mix with metallic for proper albedo and specular
    g.albedo = albedoLinear * (1.0 - g.metallic);
    
    // Get self illumination
    g.emissive = textureSample(gSelfIllum, samplerGBuffer, uv).x;
    g.selfIllum = g.albedo * g.emissive;
    
    // Default specular for dielectrics is 0.03
    g.specularColor = mix(vec3<f32>(0.03), albedoLinear, g.metallic);
    
    // View and reflection directions
    let incident_dir = normalize(g.worldPos - camera.cameraPosition);
    g.reflectedDir = normalize(reflect(incident_dir, g.normal));
    g.viewDir = -incident_dir;
    
    return g;
}


@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    // Decode GBuffer data
    let g = decodeGBuffer(uv);

    //let final_color = vec4<f32>(ibl + g.selfIllum, 1.0);
    let final_color = vec4<f32>(0.5,0.5,0.5, 1.0);
    return final_color;
}