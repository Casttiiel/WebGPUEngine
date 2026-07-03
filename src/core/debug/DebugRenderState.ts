export class DebugRenderState {
  public static showRender: boolean = false;
  public static showColliders: boolean = false;

  public static getFilter(): string | undefined {
    if (this.showRender && this.showColliders) return 'all';
    if (this.showRender)    return 'render';
    if (this.showColliders) return 'collider';
    return undefined;
  }
}
