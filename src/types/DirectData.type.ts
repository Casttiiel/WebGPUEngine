export type ImageDimensions = {
    width: number;
    height: number;
};

export type DirectImageData = {
    data: Uint8Array | Float32Array;
    dimensions: ImageDimensions;
    format: GPUTextureFormat;
};
