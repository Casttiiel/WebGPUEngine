// G-Buffer decoding functions
// This file contains common functions for decoding G-Buffer data

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
    //g.metallic = max(clamp(1.0 - normalData.a, 0.0, 1.0), g.metallic);
    
    // Gamma correction for albedo
    g.albedo = pow(abs(albedo.rgb), vec3<f32>(2.2));
    
    // Get self illumination
    g.emissive = textureSample(gSelfIllum, samplerGBuffer, uv).x;
    g.selfIllum = g.albedo * g.emissive;
    
    // Default specular for dielectrics is 0.04
    g.specularColor = mix(vec3<f32>(0.04), g.albedo, g.metallic);
    
    // View and reflection directions
    let incident_dir = normalize(g.worldPos - camera.cameraPosition);
    g.reflectedDir = normalize(reflect(incident_dir, g.normal));
    g.viewDir = -incident_dir;
    
    return g;
}
