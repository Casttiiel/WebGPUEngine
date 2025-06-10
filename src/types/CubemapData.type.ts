export type CubemapDataType = {
    faceSize: number;
    faces: ImageBitmap[];
    format?: GPUTextureFormat;
    mipLevelCount?: number;
    dimension?: GPUTextureDimension;
};
