// src/utils/ResizeEvents.ts
// Utility for onResizeStart/onResizeEnd events using ResizeObserver
// Usage: import { setupResizeEvents } from './utils/ResizeEvents';

export type ResizeEventCallback = () => void;

/**
 * Sets up resize start/end events on a target element using ResizeObserver.
 * @param element The element to observe (e.g., canvas or container)
 * @param onStart Called on first resize after idle
 * @param onEnd Called after 1s without resize events
 * @returns Cleanup function to disconnect observer
 */
export function setupResizeEvents(
  element: Element,
  onStart: ResizeEventCallback,
  onEnd: ResizeEventCallback,
  debounceMs: number = 250,
): () => void {
  let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
  let resizing = false;

  function handleStart() {
    if (!resizing) {
      resizing = true;
      onStart();
    }
  }

  function handleEnd() {
    resizing = false;
    onEnd();
  }

  const observer = new ResizeObserver(() => {
    handleStart();
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(handleEnd, debounceMs);
  });

  observer.observe(element);

  // Return cleanup function
  return () => observer.disconnect();
}
