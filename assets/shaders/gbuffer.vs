struct CameraUniforms {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    SourceSize: vec2<f32>
}

struct ObjectUniforms {
    modelMatrix: mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> object: ObjectUniforms;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) N: vec3<f32>,
    @location(1) Uv: vec2<f32>,
    @location(2) WorldPos: vec3<f32>,
    @location(3) T: vec4<f32>,
}

fn get3x3From4x4(mat: mat4x4<f32>) -> mat3x3<f32> {
    return mat3x3<f32>(
        mat[0].xyz,
        mat[1].xyz,
        mat[2].xyz
    );
}

@vertex
fn vs(
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) tangent: vec4<f32>
) -> VertexOutput {
    var output: VertexOutput;
    let worldPos = object.modelMatrix * vec4<f32>(position, 1.0);
    output.WorldPos = worldPos.xyz;
    output.position = camera.projectionMatrix * camera.viewMatrix * worldPos;
    
    let model3x3 = get3x3From4x4(object.modelMatrix);
    output.N = model3x3 * normal;
    output.T = vec4<f32>(model3x3 * tangent.xyz, tangent.w);
    output.Uv = uv;
    return output;
}