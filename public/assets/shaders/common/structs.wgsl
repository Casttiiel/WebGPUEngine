struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) N: vec3<f32>,
    @location(1) Uv: vec2<f32>,
    @location(2) WorldPos: vec3<f32>,
    @location(3) T: vec4<f32>,
}

struct ShadowsVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) worldPos: vec3<f32>,
}

struct FragmentOutput {
    @location(0) albedo: vec4<f32>,
    @location(1) normal: vec4<f32>,
    @location(2) depth: f32,
}

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

struct MaterialFactors {
    baseColorFactor: vec4<f32>,
    roughnessFactor: f32,
    metallicFactor: f32,
    emissiveFactor: f32,
    padding2: f32,
}

struct SSRUniforms {
    globalAmbientBoost: f32,
    stepSize: f32,
    maxSteps: f32,
    maxDistance: f32,
    thickness: f32,
    enabled: f32,
    padding1: f32,
    padding2: f32,
}