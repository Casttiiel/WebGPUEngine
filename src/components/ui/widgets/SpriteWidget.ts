// src/components/ui/widgets/SpriteWidget.ts
import { vec2 } from 'gl-matrix';
import { ImageWidget } from './ImageWidget';
import type { WidgetParams, ImageParams } from '../../../types/WidgetTypes';

/**
 * Sprite sheet configuration per sprite.
 */
export interface SpriteConfig {
  texture: string;
  originalImageSize: vec2; // Total sprite sheet size
  frameSize: vec2; // Size of each frame
  numFrames: number; // Total frames
  framesPerSecond: number; // Animation FPS
}

/**
 * SpriteWidget - Frame-by-frame animation with multi-sprite support.
 * Replicates C++ CSprite widget with full animation system.
 *
 * ⚠️ Supports MULTIPLE sprite sheets per widget (playingSprite index).
 */
export class SpriteWidget extends ImageWidget {
  private spriteConfigs: SpriteConfig[] = [];
  private playingSpriteIndex: number = 0;

  // Animation state
  private timeSinceStart: number = 0;
  private actualFrame: number = 1;
  private actualHorizontalFrame: number = 0;
  private actualVerticalFrame: number = 0;
  private isPlaying: boolean = false;
  private loop: boolean = true;

  constructor(
    name: string,
    alias: string,
    params: WidgetParams,
    imageParams?: Partial<ImageParams>,
  ) {
    super(name, alias, params, imageParams);
  }

  public update(dt: number): void {
    super.update(dt);

    if (!this.isPlaying || this.spriteConfigs.length === 0) return;

    const currentSprite = this.spriteConfigs[this.playingSpriteIndex];
    if (!currentSprite) return;

    this.timeSinceStart += dt;
    const frameDuration = 1.0 / currentSprite.framesPerSecond;

    if (this.timeSinceStart >= frameDuration) {
      this.advanceFrame();
      this.updateUVs();
      this.timeSinceStart = 0;
    }
  }

  // ============================================================================
  // SPRITE CONFIGURATION
  // ============================================================================

  /**
   * Add a sprite sheet configuration.
   * Returns the index of the added sprite.
   */
  public addSprite(config: SpriteConfig): number {
    this.spriteConfigs.push(config);
    return this.spriteConfigs.length - 1;
  }

  /**
   * Set which sprite is currently playing.
   */
  public setPlayingSprite(index: number): void {
    if (index >= 0 && index < this.spriteConfigs.length) {
      this.playingSpriteIndex = index;
      this.initializeSprite();
    } else {
      console.warn(`Sprite index ${index} out of range (0-${this.spriteConfigs.length - 1})`);
    }
  }

  public getPlayingSpriteIndex(): number {
    return this.playingSpriteIndex;
  }

  /**
   * Initialize sprite to first frame.
   */
  private initializeSprite(): void {
    this.actualFrame = 1;
    this.actualHorizontalFrame = 0;
    this.actualVerticalFrame = 0;
    this.timeSinceStart = 0;

    const sprite = this.spriteConfigs[this.playingSpriteIndex];
    if (sprite) {
      this.setTexture(sprite.texture);
      this.updateUVs();
    }
  }

  // ============================================================================
  // ANIMATION CONTROL
  // ============================================================================

  public play(): void {
    this.isPlaying = true;
  }

  public pause(): void {
    this.isPlaying = false;
  }

  public stop(): void {
    this.isPlaying = false;
    this.initializeSprite();
  }

  public setLoop(loop: boolean): void {
    this.loop = loop;
  }

  public isAnimationPlaying(): boolean {
    return this.isPlaying;
  }

  public setFrame(frame: number): void {
    const sprite = this.spriteConfigs[this.playingSpriteIndex];
    if (!sprite) return;

    if (frame >= 1 && frame <= sprite.numFrames) {
      this.actualFrame = frame;

      // Calculate horizontal and vertical frame indices
      const framesPerRow = Math.floor(sprite.originalImageSize[0] / sprite.frameSize[0]);
      this.actualHorizontalFrame = (frame - 1) % framesPerRow;
      this.actualVerticalFrame = Math.floor((frame - 1) / framesPerRow);

      this.updateUVs();
    }
  }

  public getCurrentFrame(): number {
    return this.actualFrame;
  }

  // ============================================================================
  // FRAME ANIMATION LOGIC
  // ============================================================================

  /**
   * Advance to next frame in the sequence.
   */
  private advanceFrame(): void {
    const sprite = this.spriteConfigs[this.playingSpriteIndex];
    if (!sprite) return;

    const framesPerRow = Math.floor(sprite.originalImageSize[0] / sprite.frameSize[0]);

    this.actualHorizontalFrame++;
    this.actualFrame++;

    // Check if we reached the end
    if (this.actualFrame > sprite.numFrames) {
      if (this.loop) {
        // Loop back to start
        this.actualFrame = 1;
        this.actualHorizontalFrame = 0;
        this.actualVerticalFrame = 0;
      } else {
        // Stop at last frame
        this.actualFrame = sprite.numFrames;
        this.isPlaying = false;
        return;
      }
    }

    // Move to next row if needed
    if (this.actualHorizontalFrame >= framesPerRow) {
      this.actualHorizontalFrame = 0;
      this.actualVerticalFrame++;
    }
  }

  /**
   * Update UV coordinates based on current frame.
   */
  private updateUVs(): void {
    const sprite = this.spriteConfigs[this.playingSpriteIndex];
    if (!sprite) return;

    // Calculate UV coordinates for current frame
    const minU = (sprite.frameSize[0] / sprite.originalImageSize[0]) * this.actualHorizontalFrame;
    const minV = (sprite.frameSize[1] / sprite.originalImageSize[1]) * this.actualVerticalFrame;
    const maxU =
      (sprite.frameSize[0] / sprite.originalImageSize[0]) * (this.actualHorizontalFrame + 1);
    const maxV =
      (sprite.frameSize[1] / sprite.originalImageSize[1]) * (this.actualVerticalFrame + 1);

    this.setMinUV(minU, minV);
    this.setMaxUV(maxU, maxV);
  }

  // ============================================================================
  // CONVENIENCE METHODS
  // ============================================================================

  /**
   * Create and add a sprite in one call.
   */
  public static createSprite(
    name: string,
    alias: string,
    params: WidgetParams,
    texture: string,
    frameWidth: number,
    frameHeight: number,
    sheetWidth: number,
    sheetHeight: number,
    totalFrames: number,
    fps: number,
    autoPlay: boolean = true,
    loop: boolean = true,
  ): SpriteWidget {
    const widget = new SpriteWidget(name, alias, params);

    widget.addSprite({
      texture,
      originalImageSize: vec2.fromValues(sheetWidth, sheetHeight),
      frameSize: vec2.fromValues(frameWidth, frameHeight),
      numFrames: totalFrames,
      framesPerSecond: fps,
    });

    widget.setPlayingSprite(0);
    widget.setLoop(loop);

    if (autoPlay) {
      widget.play();
    }

    return widget;
  }
}
