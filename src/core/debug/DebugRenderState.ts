export class DebugRenderState {
  public static showColliders: boolean = false;
  public static showSensors:   boolean = false;
  public static showLights:    boolean = false;
  public static showCameras:   boolean = false;

  public static getFilter(): string | undefined {
    const parts: string[] = [];
    if (this.showColliders) parts.push('collider');
    if (this.showSensors)   parts.push('sensor');
    if (this.showLights)    parts.push('lights');
    if (this.showCameras)   parts.push('cameras');
    return parts.length ? parts.join('|') : undefined;
  }

  public static has(filter: string | undefined, category: string): boolean {
    if (!filter) return false;
    if (filter === 'all') return true;
    return filter.includes(category);
  }
}
