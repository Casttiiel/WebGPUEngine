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

/*@group(2) @binding(0) var txEnvironment: texture_cube<f32>;
@group(2) @binding(1) var txIrradiance: texture_cube<f32>;
@group(2) @binding(2) var samplerEnv: sampler;

@group(3) @binding(0) var<uniform> ambient: AmbientUniforms;*/

fn encodeNormal(n: vec3<f32>, nw: f32) -> vec4<f32> {
    return vec4<f32>((n + 1.0) * 0.5, nw);
}

fn decodeNormal(encodedNormal: vec3<f32>) -> vec3<f32> {
    return encodedNormal * 2.0 - 1.0;
}

fn getWorldCoords(coords: vec2<f32>, zlinear_normalized: f32) -> vec3<f32> {
    let screen_coords = ((coords * 2.0) - 1.0) * camera.sourceSize;
    let view_dir_homogeneous = vec4<f32>(screen_coords, -1.0, 1.0);
    let view_dir = (camera.screenToWorld * view_dir_homogeneous).xyz;
    return view_dir * zlinear_normalized + camera.cameraPosition;
}

fn decodeGBuffer(uv: vec2<f32>, coords: vec2<f32>) -> GBuffer {
    var g: GBuffer;
    
    // Get linear depth and world position
    let zlinear = textureSample(gLinearDepth, samplerGBuffer, uv).x;
    g.zlinear = zlinear;
    g.worldPos = getWorldCoords(coords, zlinear);
    
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

fn Specular_F_Roughness(specularColor: vec3<f32>, roughness: f32, n: vec3<f32>, v: vec3<f32>) -> vec3<f32> {
    // Calculate half vector between view direction and normal
    let h = normalize(n + v);
    
    // Fresnel-Schlick
    let dotVH = max(dot(v, h), 0.0);
    let f0 = specularColor;
    let fresnel = f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - dotVH, 5.0);

    // Adjust fresnel based on roughness (this helps prevent overly bright edges on rough surfaces)
    return mix(fresnel, f0, roughness);
}

fn calculateIBL(g: GBuffer, ao: f32) -> vec3<f32> {
    // Diffuse IBL
    //let irradiance = textureSample(txIrradiance, samplerEnv, g.normal).rgb;
    let irradiance = 1.0;
    let diffuse = g.albedo * irradiance;
    
    // Specular IBL
    let rough = g.roughness * g.roughness; // Use squared roughness for better visual results
    let mipLevel = rough * 8.0; // Assuming environment map has 8 mip levels
    //let prefilteredColor = textureSampleLevel(txEnvironment, samplerEnv, g.reflectedDir, mipLevel).rgb;
    let prefilteredColor = 1.0; // Placeholder for prefiltered color
    
    // Calculate fresnel for IBL
    let fresnel = Specular_F_Roughness(g.specularColor, g.roughness, g.normal, g.viewDir);
    
    // Combine diffuse and specular IBL
    let specular = prefilteredColor * fresnel;
    
    // Energy conservation: reduce diffuse contribution based on specularity and roughness
    let energyConservation = 1.0 - rough * fresnel;
    let finalDiffuse = diffuse * energyConservation;
    
    return (finalDiffuse + 
            specular) * 
            ao;
    /*return (finalDiffuse * ambient.ambientLightIntensity + 
            specular * ambient.reflectionIntensity) * 
            ambient.globalAmbientBoost * ao;*/
}

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    // Decode GBuffer data
    let g = decodeGBuffer(uv, uv);
    // Get ambient occlusion
    //let ao = textureSample(gAO, samplerGBuffer, texCoords).r;
    let ao = 1.0;
    
    // Calculate image based lighting
    let ibl = calculateIBL(g, ao);
    
    // Add self illumination
    //let final_color = vec4<f32>(g.normal, 1.0);
    let final_color = vec4<f32>(ibl + g.selfIllum, 1.0);
    
    return final_color;
}