const PI: f32 = 3.14159265359;

fn encodeNormal(n: vec3<f32>, nw: f32) -> vec4<f32> {
    return vec4<f32>((n + 1.0) * 0.5, nw);
}

fn decodeNormal(encodedNormal: vec3<f32>) -> vec3<f32> {
    return encodedNormal * 2.0 - 1.0;
}

fn noise2D(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}

// Matrix utilities
fn get3x3From4x4(mat: mat4x4<f32>) -> mat3x3<f32> {
    return mat3x3<f32>(
        mat[0].xyz,
        mat[1].xyz,
        mat[2].xyz
    );
}

// TBN matrix calculation
fn computeTBN(inputN: vec3<f32>, inputT: vec4<f32>) -> mat3x3<f32> {
    let N = inputN;
    let T = inputT.xyz;
    let B = cross(N, T) * inputT.w;
    return mat3x3<f32>(T, B, N);
}   

fn getWorldCoords(uv: vec2<f32>, zlinear: f32, camera: CameraUniforms) -> vec3<f32> {
    // Convert UV coordinates (0-1) to NDC coordinates (-1 to 1)
    let coords = vec2<f32>(uv.x, 1.0 - uv.y);
    let ndc_coords = (coords * 2.0) - 1.0;
    
    // Get the ray direction by transforming NDC coordinates
    let near_ndc = vec4<f32>(ndc_coords.x, ndc_coords.y, 1.0, 1.0);
    let near_world_homogeneous = camera.invViewProjection * near_ndc;
    let near_world = near_world_homogeneous.xyz / near_world_homogeneous.w;

    // Calculate the ray direction from camera to the point (in WORLD coordinates)
    let ray_direction = normalize(near_world - camera.cameraPosition);
    
    // zlinear was calculated as: dot(worldPos - cameraPos, cameraFront) / zFar
    // So: distance_along_front = zlinear * zFar
    // But we need distance_along_ray = distance_along_front / dot(ray_direction, cameraFront)
    let distance_along_front = zlinear * camera.cameraZFar;
    let distance_along_ray = distance_along_front / dot(ray_direction, camera.cameraFront);
    
    // Calculate final world position
    return camera.cameraPosition + ray_direction * distance_along_ray;
}


// Helper function for saturate (clamp to 0-1)
fn saturate(x: f32) -> f32 {
    return clamp(x, 0.0, 1.0);
}

// PBR helper functions
fn NormalDistribution_GGX(NdotH: f32, roughness: f32) -> f32 {
    let a2 = roughness * roughness;
    let NdotH2 = NdotH * NdotH;
    
    let num = a2;
    var denom = (NdotH2 * (a2 - 1.0) + 1.0);
    denom = PI * denom * denom;
    
    return num / denom;
}

fn Geometric_Smith_Schlick_GGX(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
    let r = (roughness + 1.0);
    let k = (r * r) / 8.0;
    
    let ggx2 = NdotV / (NdotV * (1.0 - k) + k);
    let ggx1 = NdotL / (NdotL * (1.0 - k) + k);
    
    return ggx1 * ggx2;
}

fn Geometry_SmithGGX_Correlated(NdV: f32, NdL: f32, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let gv = NdL * sqrt(NdV * (NdV - NdV * a) + a);
    let gl = NdV * sqrt(NdL * (NdL - NdL * a) + a);
    return 0.5 / max(gv + gl, 0.0001);
}

fn Fresnel_Schlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
    return F0 + (1.0 - F0) * pow(saturate(1.0 - cosTheta), 5.0);
}

fn Fresnel_Schlick_Roughness(cosTheta: f32, F0: vec3<f32>, roughness: f32) -> vec3<f32> {
    let oneMinusRoughness = 1.0 - roughness;
    return F0 + (max(vec3f(oneMinusRoughness), F0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn Specular(specularColor: vec3<f32>, h: vec3<f32>, v: vec3<f32>, l: vec3<f32>, roughnessSquared: f32, NdL: f32, NdV: f32, NdH: f32, VdH: f32, LdV: f32) -> vec3<f32> {
    let F0 = specularColor;

    let roughness = sqrt(roughnessSquared);
    
    let NDF = NormalDistribution_GGX(NdH, roughness);
    let G = Geometric_Smith_Schlick_GGX(NdV, NdL, roughness);
    //let G = Geometry_SmithGGX_Correlated(NdV, NdL, roughness);
    let F = Fresnel_Schlick(VdH, F0);
    
    let numerator = NDF * G * F;
    let denominator = 4.0 * NdV * NdL + 0.0001; // Prevent division by zero
    
    return numerator / denominator;
}

fn Diffuse(pAlbedo: vec3<f32>) -> vec3<f32> {
    return pAlbedo / PI;
}


fn get_view_dir(clip_pos: vec3<f32>) -> vec3<f32> {
    // Para una matriz de proyección perspectiva, podemos reconstruir la dirección en view space
    // usando el fov y aspect ratio implícitos en la matriz de proyección
    let fov = atan(1.0 / camera.projectionMatrix[1][1]); // Extract FOV from projection matrix
    let aspect = camera.projectionMatrix[1][1] / camera.projectionMatrix[0][0]; // Extract aspect ratio
    
    // Reconstruir la dirección en view space
    var view_dir = vec3<f32>(
        clip_pos.x * tan(fov) * aspect,
        clip_pos.y * tan(fov),
        -1.0
    );
    
    return normalize(view_dir);
}

fn get_world_dir(view_dir: vec3<f32>) -> vec3<f32> {
    // Para el skybox, solo necesitamos la inversa de la rotación de la vista
    // Lo cual es equivalente a la transpuesta de la matriz 3x3 superior izquierda
    let rotation = transpose(mat3x3<f32>(
        camera.viewMatrix[0].xyz,
        camera.viewMatrix[1].xyz,
        camera.viewMatrix[2].xyz
    ));
    
    return rotation * view_dir;
}

fn direction_to_equirect_uv(dir: vec3<f32>) -> vec2<f32> {
    let theta = atan2(dir.x, dir.z); // [-PI, PI]
    let phi = acos(clamp(dir.y, -1.0, 1.0)); // [0, PI]
    let u = (theta + PI) / (2.0 * PI); // [0, 1]
    let v = phi / PI; // [0, 1]
    return vec2<f32>(u, v);
}

fn shadowsTap(homo_coord: vec2<f32>, coord_z: f32, normal: vec3<f32>, lightDir: vec3<f32>, shadowMap: texture_depth_2d, shadowSampler: sampler_comparison) -> f32 {
    // Quick optimization: clamp coordinates instead of branching
    if (homo_coord.x < 0.0 || homo_coord.x > 1.0 ||
        homo_coord.y < 0.0 || homo_coord.y > 1.0) {
        return 1.0;
    }
    // Bias adaptativo más conservador (reducido para evitar peter-panning)
    // Con depth bias en el pipeline, el bias en shader puede ser mucho menor
    let cosTheta = clamp(dot(normal, -lightDir), 0.001, 1.0);
    let tanTheta = sqrt(1.0 - cosTheta * cosTheta) / cosTheta;
    let slopeBias = clamp(tanTheta * 0.0001, 0.0, 0.001);
    let baseBias = 0.000001;
    let totalBias = baseBias + slopeBias;
    let biased_depth = coord_z - totalBias;
    return textureSampleCompareLevel(shadowMap, shadowSampler, homo_coord, baseBias);
}

fn hash2(p: f32) -> vec2<f32> {
    let n = sin(p * 12.9898 + 78.233) * 43758.5453;
    return fract(vec2<f32>(n, n * 1.3));
}

fn hash3(p: vec3<f32>) -> f32 {
    return fract(sin(dot(p, vec3<f32>(12.9898, 78.233, 37.719))) * 43758.5453);
}

fn getShadowFactor(wPos: vec3<f32>, normal: vec3<f32>, lightDir: vec3<f32>, lightViewProjOffset: mat4x4<f32>, lightShadowStepDivResolution: f32, shadowMap: texture_depth_2d, shadowSampler: sampler_comparison, adaptUVs: bool, cascadeIndex: i32) -> f32 {
    let lightProjSpacePos = lightViewProjOffset * vec4<f32>(wPos, 1.0);
    var lightUVSpacePos = lightProjSpacePos.xyz / lightProjSpacePos.w;
    if (adaptUVs) {
        lightUVSpacePos.x = lightUVSpacePos.x * 0.5 + 0.5;
        lightUVSpacePos.y = lightUVSpacePos.y * -0.5 + 0.5;
    }
    // Si está fuera del rango, no hay sombra
    if (lightUVSpacePos.z < 0.0 || lightUVSpacePos.z > 1.0) {
        return 1.0;
    }
    if (lightUVSpacePos.x < 0.0 || lightUVSpacePos.x > 1.0 ||
        lightUVSpacePos.y < 0.0 || lightUVSpacePos.y > 1.0) {
        return 1.0;
    }

    // PCF 3x3
    let texelSize = lightShadowStepDivResolution;
    var shadow = 0.0;
    for (var dx = -1; dx <= 1; dx = dx + 1) {
        for (var dy = -1; dy <= 1; dy = dy + 1) {
            let offset = vec2<f32>(f32(dx), f32(dy)) * texelSize;
            shadow += textureSampleCompareLevel(shadowMap, shadowSampler, lightUVSpacePos.xy + offset, lightUVSpacePos.z);
        }
    }
    shadow = shadow / 9.0;
    return shadow;
}