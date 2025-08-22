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
    let a2 = roughness;
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

fn Fresnel_Schlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
    return F0 + (1.0 - F0) * pow(saturate(1.0 - cosTheta), 5.0);
}

fn Fresnel_Schlick_Roughness(cosTheta: f32, F0: vec3<f32>, roughness: f32) -> vec3<f32> {
    return F0 + (max(vec3f(1.0 - roughness), F0) - F0) * pow(1.0 - cosTheta, 5.0);
}

fn Specular(specularColor: vec3<f32>, h: vec3<f32>, v: vec3<f32>, l: vec3<f32>, a: f32, NdL: f32, NdV: f32, NdH: f32, VdH: f32, LdV: f32) -> vec3<f32> {
    let F0 = specularColor;
    
    // Cook-Torrance BRDF
    let NDF = NormalDistribution_GGX(NdH, a);
    let G = Geometric_Smith_Schlick_GGX(NdV, NdL, a);
    let F = Fresnel_Schlick_Roughness(VdH, F0, a);
    
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
    let dir_n = normalize(dir);
    let u = (atan2(dir_n.z, dir_n.x) / (2.0 * 3.1415926535)) + 0.5;
    let v = (asin(dir_n.y) / 3.1415926535) + 0.5;
    return vec2<f32>(u, v);
}

fn shadowsTap(homo_coord: vec2<f32>, coord_z: f32, shadowMap: texture_depth_2d, shadowSampler: sampler_comparison) -> f32 {
    // Quick optimization: clamp coordinates instead of branching
    let clamped_coord = clamp(homo_coord, vec2<f32>(0.0), vec2<f32>(1.0));
    
    // Slope-scaled bias - más bias en superficies inclinadas
    // Aproximación simple sin textureSampleGrad (no compatible con comparison sampler)
    let bias = 0.0005; // Bias base
    
    let biased_depth = coord_z - bias;
    return textureSampleCompareLevel(shadowMap, shadowSampler, clamped_coord, biased_depth);
}

fn hash2(p: f32) -> vec2<f32> {
    let n = sin(p * 12.9898 + 78.233) * 43758.5453;
    return fract(vec2<f32>(n, n * 1.3));
}

fn hash3(p: vec3<f32>) -> f32 {
    return fract(sin(dot(p, vec3<f32>(12.9898, 78.233, 37.719))) * 43758.5453);
}

fn getShadowFactor(wPos: vec3<f32>, lightViewProjOffset: mat4x4<f32>, lightShadowStepDivResolution: f32, shadowMap: texture_depth_2d, shadowSampler: sampler_comparison, adaptUVs: bool) -> f32 {
    let lightProjSpacePos = lightViewProjOffset * vec4<f32>(wPos, 1.0);
    var lightUVSpacePos = lightProjSpacePos.xyz / lightProjSpacePos.w;
    if(adaptUVs){
        lightUVSpacePos.x = lightUVSpacePos.x * 0.5 + 0.5;
        lightUVSpacePos.y = lightUVSpacePos.y * -0.5 + 0.5;
    }

    // Verificar que esté dentro del rango válido de la shadow map
    if (lightUVSpacePos.z < 0.0 || lightUVSpacePos.z > 1.0) {
        return 0.0; // Fuera del rango de profundidad = sin sombra
    }

    if (lightUVSpacePos.x < 0.0 || lightUVSpacePos.x > 1.0 || 
        lightUVSpacePos.y < 0.0 || lightUVSpacePos.y > 1.0) {
        return 0.0; // Fuera del rango UV = sin sombra
    }

    // PCF 4x4 con patrón Poisson disk para mejor distribución
    let filterRadius = lightShadowStepDivResolution; // Radio más grande para sombras más suaves
    
    // Añadir rotación aleatoria para romper patrones y hacer soft shadows
    let random = hash3(wPos) * 2.0 * PI; // 2*PI
    let cosR = cos(random);
    let sinR = sin(random);
    
    // Poisson disk offsets para mejor sampling
    let offsets = array<vec2<f32>, 16>(
        vec2<f32>(-0.942016, -0.39906),
        vec2<f32>(-0.094184, -0.92938),
        vec2<f32>(-0.344959, -0.40023),
        vec2<f32>(-0.791559, -0.59771),
        vec2<f32>(-0.310390, 0.90469),
        vec2<f32>(-0.943749, 0.05449),
        vec2<f32>(-0.032820, 0.58806),
        vec2<f32>(-0.611406, 0.17495),
        vec2<f32>(0.147506, -0.47438),
        vec2<f32>(0.455077, -0.76838),
        vec2<f32>(0.542570, -0.17333),
        vec2<f32>(0.904524, -0.23376),
        vec2<f32>(0.277191, 0.48309),
        vec2<f32>(0.674189, 0.41622),
        vec2<f32>(0.954331, 0.65465),
        vec2<f32>(0.423446, 0.84157)
    );
    
    var shadow = 0.0;
    for (var i = 0; i < 16; i++) {
        // Rotar offsets para eliminar patrones regulares y crear soft shadows
        let rotatedOffset = vec2<f32>(
            offsets[i].x * cosR - offsets[i].y * sinR,
            offsets[i].x * sinR + offsets[i].y * cosR
        );
        let sampleCoord = lightUVSpacePos.xy + rotatedOffset * filterRadius;
        shadow += shadowsTap(sampleCoord, lightUVSpacePos.z, shadowMap, shadowSampler);
    }
    
    let shadowResult = shadow / 16.0;
    // Suavizar bordes para soft shadows
    return smoothstep(0.1, 0.9, shadowResult);
}