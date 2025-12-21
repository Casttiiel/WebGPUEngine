import { BaseResource, IResourceOptions } from './IResource';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';

export interface IGPUResourceOptions extends IResourceOptions {
  label?: string;
}

export abstract class GPUResource extends BaseResource {
  protected device: GPUDevice;
  protected label: string;
  protected name: string;

  constructor(options: IGPUResourceOptions) {
    super(options);
    this.device = GPUUtils.getDevice();
    this.label = options.label || options.path;
    this.name = options.path;
  }

  public getName(): string {
    return this.name;
  }
}
