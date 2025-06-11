// Normal map encoding/decoding
fn encodeNormal(n: vec3<f32>, nw: f32) -> vec4<f32> {
    return vec4<f32>((n + 1.0) * 0.5, nw);
}

fn decodeNormal(encodedNormal: vec3<f32>) -> vec3<f32> {
    return encodedNormal * 2.0 - 1.0;
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

fn getWorldCoords(coords: vec2<f32>, zlinear: f32, camera: CameraUniforms) -> vec3<f32> {
    // Generar el rayo en espacio mundo usando la matriz screenToWorld
    let worldRay = (camera.screenToWorld * vec4<f32>(coords, 0.0, 1.0)).xyz;
    
    // Normalizar el rayo y escalar por la profundidad lineal
    return camera.cameraPosition + normalize(worldRay) * (zlinear * camera.cameraZFar);
}