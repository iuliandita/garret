// lab/bakeoff/editor-core/src/measure.ts
// In-page latency recorder. For each dispatched key we stamp performance.now()
// and, on the next animation frame AFTER ProseMirror has committed the DOM,
// record the delta. No CDP, no tracing: identical in WebKitGTK and Chromium.
import { frameDelta } from "./stats";

export interface Recorder {
  markKey(): void; // call immediately before dispatching the key
  settle(): Promise<number>; // resolves with the frame-commit latency in ms
}

export function createRecorder(): Recorder {
  let keyTs = 0;
  return {
    markKey() {
      keyTs = performance.now();
    },
    settle() {
      return new Promise<number>((resolve) => {
        // Double rAF: first frame flushes the transaction's DOM write, the
        // second fires after the browser has laid it out and painted.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve(frameDelta(keyTs, performance.now())));
        });
      });
    },
  };
}
