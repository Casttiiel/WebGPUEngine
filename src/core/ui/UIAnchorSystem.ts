import { UIRenderUtils } from '../../renderer/core/UIRenderUtils.js';

/**
 * Anchor types â€” define which screen edge/corner a root widget is relative to.
 * Children widgets do NOT use anchors; they are always relative to their parent's top-left.
 */
export enum AnchorType {
  CENTER = 'center',
  TOP_LEFT = 'top-left',
  TOP_CENTER = 'top-center',
  TOP_RIGHT = 'top-right',
  BOTTOM_LEFT = 'bottom-left',
  BOTTOM_CENTER = 'bottom-center',
  BOTTOM_RIGHT = 'bottom-right',
  LEFT_CENTER = 'left-center',
  RIGHT_CENTER = 'right-center',
}

/**
 * UIAnchorSystem â€” maps anchor types to a physical-pixel base coordinate.
 *
 * Widget.computeAbsolute() calls getAnchorBasePhysical() to obtain the
 * starting point from which (x * gs, y * gs) is added.
 *
 * Examples (1920Ã—1080 screen, gs=1):
 *   bottom-left  + x=40,  y=-80  â†’ origin at (40, 1000)     â€” 40px from left, 80px from bottom
 *   top-right    + x=-200, y=20  â†’ origin at (1720, 20)     â€” 200px from right, 20px from top
 *   center       + x=-405, y=-540 â†’ origin at (555, 0)      â€” centred 811px-wide element
 */
export class UIAnchorSystem {
  /**
   * Returns the physical-pixel base point for a given anchor.
   * The widget's (x * gs, y * gs) offset is added on top of this base.
   */
  public static getAnchorBasePhysical(anchor: AnchorType): [number, number] {
    const W = UIRenderUtils.getScreenWidth();
    const H = UIRenderUtils.getScreenHeight();

    switch (anchor) {
      case AnchorType.TOP_LEFT:
        return [0, 0];
      case AnchorType.TOP_CENTER:
        return [W / 2, 0];
      case AnchorType.TOP_RIGHT:
        return [W, 0];
      case AnchorType.BOTTOM_LEFT:
        return [0, H];
      case AnchorType.BOTTOM_CENTER:
        return [W / 2, H];
      case AnchorType.BOTTOM_RIGHT:
        return [W, H];
      case AnchorType.LEFT_CENTER:
        return [0, H / 2];
      case AnchorType.RIGHT_CENTER:
        return [W, H / 2];
      case AnchorType.CENTER:
      default:
        return [W / 2, H / 2];
    }
  }

  /**
   * Parse anchor string from JSON.
   * Returns null if the string is not a recognised anchor type.
   */
  public static parseAnchorType(anchorStr: string): AnchorType | null {
    const s = anchorStr.toLowerCase().trim();
    switch (s) {
      case 'center':
        return AnchorType.CENTER;
      case 'top-left':
        return AnchorType.TOP_LEFT;
      case 'top-center':
        return AnchorType.TOP_CENTER;
      case 'top-right':
        return AnchorType.TOP_RIGHT;
      case 'bottom-left':
        return AnchorType.BOTTOM_LEFT;
      case 'bottom-center':
        return AnchorType.BOTTOM_CENTER;
      case 'bottom-right':
        return AnchorType.BOTTOM_RIGHT;
      case 'left-center':
        return AnchorType.LEFT_CENTER;
      case 'right-center':
        return AnchorType.RIGHT_CENTER;
      default:
        console.warn(`UIAnchorSystem: unknown anchor "${anchorStr}"`);
        return null;
    }
  }
}
