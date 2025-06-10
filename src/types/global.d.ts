/// <reference types="@webgpu/types" />

declare global {
  interface Window {
    requestAnimationFrame(callback: FrameRequestCallback): number;
    cancelAnimationFrame(handle: number): void;
  }

  var window: Window;
  var document: Document;
  var navigator: Navigator;
  var performance: Performance;
  var console: Console;
  var fetch: typeof fetch;
  var requestAnimationFrame: typeof window.requestAnimationFrame;
  var cancelAnimationFrame: typeof window.cancelAnimationFrame;
  var createImageBitmap: typeof window.createImageBitmap;
  var Image: typeof window.Image;
  var OffscreenCanvas: typeof window.OffscreenCanvas;
  var ImageBitmap: typeof window.ImageBitmap;
  var ResizeObserver: typeof window.ResizeObserver;
}

export {};
