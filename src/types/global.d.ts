/// <reference types="@webgpu/types" />

declare global {
  interface Window {
    requestAnimationFrame(callback: FrameRequestCallback): number;
    cancelAnimationFrame(handle: number): void;
  }

  let window: Window;
  let document: Document;
  let navigator: Navigator;
  let performance: Performance;
  let console: Console;
  let fetch: typeof fetch;
  let requestAnimationFrame: typeof window.requestAnimationFrame;
  let cancelAnimationFrame: typeof window.cancelAnimationFrame;
  let createImageBitmap: typeof window.createImageBitmap;
  let Image: typeof window.Image;
  let OffscreenCanvas: typeof window.OffscreenCanvas;
  let ImageBitmap: typeof window.ImageBitmap;
  let ResizeObserver: typeof window.ResizeObserver;
}

export {};
