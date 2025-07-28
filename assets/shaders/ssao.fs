#include "common/uniforms"
#include "common/utils"

struct SSAOParams {
    sampleCount: u32,
    radius: f32,
    bias: f32,
    aoStrength: f32,
    maxDistance: f32,
    occScale: f32,
}

// 64 muestras precalculadas en una hemisfera
const SAMPLE_OFFSETS = array<vec3<f32>, 64>(
    vec3<f32>(0.049771, -0.044709, 0.049963),
    vec3<f32>(0.014575, 0.016531, 0.002239),
    vec3<f32>(-0.040648, -0.019375, 0.031934),
    vec3<f32>(0.013778, -0.091582, 0.040924),
    vec3<f32>(0.055989, 0.059792, 0.057659),
    vec3<f32>(0.092266, 0.044279, 0.015451),
    vec3<f32>(-0.002039, -0.054402, 0.066735),
    vec3<f32>(-0.000331, -0.000187, 0.000369),
    vec3<f32>(0.050044, -0.046650, 0.025385),
    vec3<f32>(0.038128, 0.031402, 0.032868),
    vec3<f32>(-0.031883, 0.020459, 0.022515),
    vec3<f32>(0.055702, -0.036974, 0.054492),
    vec3<f32>(0.057372, -0.022540, 0.075542),
    vec3<f32>(-0.016090, -0.003768, 0.055473),
    vec3<f32>(-0.025033, -0.024829, 0.024951),
    vec3<f32>(-0.033688, 0.021391, 0.025402),
    vec3<f32>(-0.017530, 0.014386, 0.005348),
    vec3<f32>(0.073359, 0.112052, 0.011014),
    vec3<f32>(-0.044056, -0.090284, 0.083683),
    vec3<f32>(-0.083277, -0.001683, 0.084987),
    vec3<f32>(-0.010406, -0.032867, 0.019273),
    vec3<f32>(0.003211, -0.004882, 0.004164),
    vec3<f32>(-0.007383, -0.065835, 0.067398),
    vec3<f32>(0.094141, -0.007998, 0.143350),
    vec3<f32>(0.076833, 0.126968, 0.106999),
    vec3<f32>(0.000393, 0.000450, 0.000302),
    vec3<f32>(-0.104793, 0.065445, 0.101737),
    vec3<f32>(-0.004452, -0.119638, 0.161901),
    vec3<f32>(-0.074553, 0.034449, 0.224138),
    vec3<f32>(-0.002758, 0.003078, 0.002923),
    vec3<f32>(-0.108512, 0.142337, 0.166435),
    vec3<f32>(0.046882, 0.103636, 0.059576),
    vec3<f32>(0.134569, -0.022512, 0.130514),
    vec3<f32>(-0.164490, -0.155644, 0.124540),
    vec3<f32>(-0.187666, -0.208834, 0.057770),
    vec3<f32>(-0.043722, 0.086925, 0.074797),
    vec3<f32>(-0.002564, -0.002001, 0.004070),
    vec3<f32>(-0.096696, -0.182259, 0.299487),
    vec3<f32>(-0.225767, 0.316061, 0.089156),
    vec3<f32>(-0.027505, 0.287187, 0.317177),
    vec3<f32>(0.207216, -0.270839, 0.110132),
    vec3<f32>(0.054902, 0.104345, 0.323106),
    vec3<f32>(-0.130860, 0.119294, 0.280219),
    vec3<f32>(0.154035, -0.065371, 0.229842),
    vec3<f32>(0.052938, -0.227866, 0.148478),
    vec3<f32>(-0.187305, -0.040225, 0.015926),
    vec3<f32>(0.141843, 0.047163, 0.134847),
    vec3<f32>(-0.044268, 0.055616, 0.055859),
    vec3<f32>(-0.023583, -0.080970, 0.219130),
    vec3<f32>(-0.142147, 0.198069, 0.005194),
    vec3<f32>(0.158646, 0.230457, 0.043715),
    vec3<f32>(0.030040, 0.381832, 0.163825),
    vec3<f32>(0.083006, -0.309661, 0.067413),
    vec3<f32>(0.226953, -0.235350, 0.193673),
    vec3<f32>(0.381287, 0.332041, 0.529492),
    vec3<f32>(-0.556272, 0.294715, 0.301101),
    vec3<f32>(0.424490, 0.005647, 0.117578),
    vec3<f32>(0.366500, 0.003588, 0.085702),
    vec3<f32>(0.329018, 0.030898, 0.178504),
    vec3<f32>(-0.082938, 0.512848, 0.056555),
    vec3<f32>(0.867363, -0.002734, 0.100138),
    vec3<f32>(0.455745, -0.772006, 0.003841),
    vec3<f32>(0.417290, -0.154846, 0.462514),
    vec3<f32>(-0.442722, -0.679282, 0.186503)
);

const ROT_TEXTURE_WIDTH: f32 = 4.0;
const ROT_TEXTURE_HEIGHT: f32 = 4.0;

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var gSelfIllum: texture_2d<f32>;
@group(1) @binding(4) var gAO: texture_2d<f32>;
@group(1) @binding(5) var samplerGBuffer: sampler;

// Uniform buffer para parámetros SSAO
@group(2) @binding(0) var<uniform> ssaoParams: SSAOParams;

fn noise2D(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}


@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) f32 {
    let centerZBuffer = textureSample(gLinearDepth, samplerGBuffer, uv).r;
    let normal = decodeNormal(textureSample(gNormals, samplerGBuffer, uv).xyz)

    let noiseScale = vec2<f32>(
        camera.screenSize.x / ROT_TEXTURE_WIDTH,
        camera.screenSize.y / ROT_TEXTURE_HEIGHT
    );

    let rand = normalize(vec3<f32>(
        noise2D(uv * noiseScale), 
        noise2D(uv * noiseScale + vec2<f32>(1.0)), 
        0.0
    ));

    // Construir matriz TBN
    //let randomVec = vec3<f32>(1.0);normalize(textureSample(texRotation, samplerGBuffer, uv * noiseScale).xyz);
    let N = camera.viewMatrix * vec4<f32>(,0.0);
    let normal = normalize(N.xyz);
    let tangent = normalize(rand - normal * dot(rand, normal));
    let bitangent = cross(normal, tangent);
    let TBN = mat3x3<f32>(tangent, bitangent, normal);

    var att = 0.0;

let viewSpaceVec = TBN * SAMPLE_OFFSETS[0];
        var offsetUV = uv + (viewSpaceVec.xy * 1.5 / Z);
        offsetUV = clamp(offsetUV, vec2<f32>(0.0), vec2<f32>(1.0));

        let zSample = textureSample(gLinearDepth, samplerGBuffer, offsetUV).r;

    // Muestreo de oclusión
    /*for (var i = 0u; i < 64u; i = i + 1u) {
        let viewSpaceVec = TBN * SAMPLE_OFFSETS[i];
        var offsetUV = uv + (viewSpaceVec.xy * 0.5 / Z);
        offsetUV = clamp(offsetUV, vec2<f32>(0.0), vec2<f32>(1.0));

        let zSample = textureSample(gLinearDepth, samplerGBuffer, offsetUV).r;

        let dist = max(Z - zSample, 0.0) / 1.0;
        let occl = 1.0 * max(dist * (2.0 - dist), 0.0);

        att += 1.0 / (1.0 + occl * occl);
    }*/

    att = clamp(att / f32(64), 0.0, 1.0) * 1.0;
    
    return zSample;
}
