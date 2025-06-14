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

struct AmbientUniforms {
    reflectionIntensity: f32,
    ambientLightIntensity: f32,
    globalAmbientBoost: f32,
    padding: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var gSelfIllum: texture_2d<f32>;
@group(1) @binding(4) var gAO: texture_2d<f32>;
@group(1) @binding(5) var samplerGBuffer: sampler;

@group(2) @binding(0) var txEnvironment: texture_cube<f32>;
@group(2) @binding(1) var samplerEnv: sampler;
@group(3) @binding(0) var<uniform> ambient: AmbientUniforms;


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

// PBR Fresnel-Schlick approximation for IBL
fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
    return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

// PBR Fresnel with roughness compensation for IBL
fn fresnelSchlickRoughness(cosTheta: f32, F0: vec3<f32>, roughness: f32) -> vec3<f32> {
    let oneMinusRoughness = vec3<f32>(1.0 - roughness);
    return F0 + (max(oneMinusRoughness, F0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn calculateIBL(g: GBuffer, ao: f32) -> vec3<f32> {
    let N = normalize(g.normal);
    let V = normalize(g.viewDir);
    let R = normalize(g.reflectedDir);
    
    // Calculate angles for PBR
    let NdotV = max(dot(N, V), 0.0);
    
    // PBR material properties
    let F0 = mix(vec3<f32>(0.04), g.albedo, g.metallic); // Base reflectance
    
    // Sample diffuse irradiance (should be pre-convolved for lambertian BRDF)
    let irradiance = textureSampleLevel(txEnvironment, samplerEnv, N, 0.0).rgb;
    
    // Sample specular radiance with roughness-based mip level
    let roughness = g.roughness;
    //let mipLevel = roughness * 7.0; // Assuming 8 mip levels (0-7)
    let mipLevel = 0.0;
    let prefilteredColor = textureSampleLevel(txEnvironment, samplerEnv, R, mipLevel).rgb;
    
    // Calculate Fresnel term for IBL
    let F = fresnelSchlickRoughness(NdotV, F0, roughness);
    
    // Energy conservation
    let kS = F; // Specular contribution
    let kD = (vec3<f32>(1.0) - kS) * (1.0 - g.metallic); // Diffuse only for non-metals
    
    // Diffuse contribution
    let diffuse = kD * g.albedo * irradiance;
    
    // Specular contribution
    // For a proper PBR pipeline, you would sample a BRDF integration map here
    // For now, we'll use a simplified approach
    let specular = prefilteredColor * F;
    
    // Combine and apply ambient occlusion
    return (diffuse * ambient.ambientLightIntensity + specular * ambient.reflectionIntensity) * ambient.globalAmbientBoost * ao;
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    // Decode GBuffer data
    let g = decodeGBuffer(uv);
    // Get ambient occlusion
    let ao = textureSample(gAO, samplerGBuffer, uv).r;
    
    // Calculate image based lighting
    let ibl = calculateIBL(g, ao);

    //let final_color = vec4<f32>(ibl + g.selfIllum, 1.0);
    let final_color = vec4<f32>(ibl + g.selfIllum, 1.0);
    return final_color;
}