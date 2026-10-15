@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let dims = textureDimensions(inputTexture);
    let outDims = textureDimensions(outputTexture);
    
    if (global_id.x >= outDims.x || global_id.y >= outDims.y) {
        return;
    }

    let coord = vec2<i32>(global_id.xy);
    let inCoord = coord * 2;
    
    // Sample 4 texels from the higher resolution mip level
    let c00 = textureLoad(inputTexture, inCoord + vec2<i32>(0, 0), 0);
    let c10 = textureLoad(inputTexture, inCoord + vec2<i32>(1, 0), 0);
    let c01 = textureLoad(inputTexture, inCoord + vec2<i32>(0, 1), 0);
    let c11 = textureLoad(inputTexture, inCoord + vec2<i32>(1, 1), 0);
    
    // Average the four samples
    let color = (c00 + c10 + c01 + c11) * 0.25;
    
    // Write the result to the next mip level
    textureStore(outputTexture, coord, color);
}
