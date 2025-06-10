import { BaseResource, IResourceOptions } from './IResource';
import { Render } from '../../renderer/core/render';

export interface IGPUResourceOptions extends IResourceOptions {
  label?: string;
}

export abstract class GPUResource extends BaseResource {
  protected device: GPUDevice;
  protected label: string;

  constructor(options: IGPUResourceOptions) {
    super(options);
    this.device = Render.getInstance().getDevice();
    this.label = options.label || options.path;
  }
}
