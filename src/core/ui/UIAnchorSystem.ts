import { vec2 } from 'gl-matrix';

/**
 * Anchor types for positioning UI widgets
 * Defines 9 standard anchor points on the screen
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
 * Static utility class for calculating anchor positions
 * Used by widgets to position themselves relative to screen edges/corners
 */
export class UIAnchorSystem {
  /**
   * Get the position of an anchor point in reference canvas space
   * @param anchor - The anchor type (center, top-left, etc.)
   * @param refWidth - Reference canvas width (e.g., 1920)
   * @param refHeight - Reference canvas height (e.g., 1080)
   * @returns Position [x, y] in reference canvas coordinates
   */
  public static getAnchorPosition(anchor: AnchorType, refWidth: number, refHeight: number): vec2 {
    const pos = vec2.create();

    switch (anchor) {
      case AnchorType.CENTER:
        return vec2.fromValues(refWidth / 2, refHeight / 2);

      case AnchorType.TOP_LEFT:
        return vec2.fromValues(0, 0);

      case AnchorType.TOP_CENTER:
        return vec2.fromValues(refWidth / 2, 0);

      case AnchorType.TOP_RIGHT:
        return vec2.fromValues(refWidth, 0);

      case AnchorType.BOTTOM_LEFT:
        return vec2.fromValues(0, refHeight);

      case AnchorType.BOTTOM_CENTER:
        return vec2.fromValues(refWidth / 2, refHeight);

      case AnchorType.BOTTOM_RIGHT:
        return vec2.fromValues(refWidth, refHeight);

      case AnchorType.LEFT_CENTER:
        return vec2.fromValues(0, refHeight / 2);

      case AnchorType.RIGHT_CENTER:
        return vec2.fromValues(refWidth, refHeight / 2);

      default:
        console.warn(`UIAnchorSystem: Unknown anchor type ${anchor}, defaulting to center`);
        return vec2.fromValues(refWidth / 2, refHeight / 2);
    }
  }

  /**
   * Parse anchor type from string
   * @param anchorStr - Anchor string from JSON (e.g., "top-left", "center")
   * @returns AnchorType enum value or null if invalid
   */
  public static parseAnchorType(anchorStr: string): AnchorType | null {
    const normalized = anchorStr.toLowerCase().trim();

    switch (normalized) {
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
        return null;
    }
  }
}
