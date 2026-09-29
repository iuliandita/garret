// The window size a capture asks for, and the X screen it needs. Pure, so
// the floor and the fit are testable without a display.
import { SERVER_ARGS } from "./shell";

export interface Size {
  width: number;
  height: number;
}

/** The host's own floor (`projects.rs` MIN_WINDOW). Restated, not
 *  imported: the harness restates thresholds so a drift is a failing
 *  test rather than a silent agreement. */
export const MIN_WINDOW: Size = { width: 640, height: 480 };

/** Above this an X screen needs more than 16 bits per axis and Xvfb refuses
 *  to start -- a failure that reads as "no sink payload", naming nothing
 *  about the size that caused it. Refusing here names the real reason. */
export const MAX_WINDOW = 8192;

/** The geometry `-screen 0 WxHxD` names inside a set of Xvfb server args.
 *  Parsed rather than assumed present, so a malformed argument string fails
 *  loudly instead of silently answering `undefined x undefined`. */
export function screenOf(serverArgs: string): Size {
  const m = /-screen \d+ (\d+)x(\d+)x\d+/.exec(serverArgs);
  if (m === null) throw new Error(`no "-screen N WxHxD" in server args: "${serverArgs}"`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** The shared Xvfb screen, derived from `SERVER_ARGS` rather than restated as
 *  a literal: a flag added to that constant, or a changed geometry, carries
 *  over here without a second place to edit. */
export const SHARED_SCREEN: Size = screenOf(SERVER_ARGS);

/** `WxH`, both positive integers, at or above the floor and at or below the
 *  ceiling. Anything else throws with the reason: the host would silently
 *  clamp a size under the floor, and a size over the ceiling makes Xvfb fail
 *  to start with no message about why. */
export function parseSize(text: string): Size {
  const m = /^(\d+)x(\d+)$/.exec(text);
  if (m === null) throw new Error(`--size wants WIDTHxHEIGHT in pixels, got "${text}"`);
  const size = { width: Number(m[1]), height: Number(m[2]) };
  if (size.width < MIN_WINDOW.width || size.height < MIN_WINDOW.height) {
    throw new Error(
      `--size ${text} is under the host's floor of ${MIN_WINDOW.width}x${MIN_WINDOW.height}; ` +
        "the window would open at the floor and the capture would not show the size asked for",
    );
  }
  if (size.width > MAX_WINDOW || size.height > MAX_WINDOW) {
    throw new Error(`--size ${text} is over the ${MAX_WINDOW}x${MAX_WINDOW} ceiling Xvfb can start at`);
  }
  return size;
}

/** The X server arguments for a window of `size`: the shared screen when it
 *  fits with margin, a wider one otherwise.
 *
 *  The margin is not "room for the frame" -- xvfb-run runs no window manager,
 *  so there is no frame. It is room to move the pointer past the window's
 *  right and bottom edges, which the xdotool routes do, and room for the
 *  host's own fit-to-screen (`WindowSize::fit`) to never clamp the size
 *  asked for by finding the screen exactly as large as the window.
 *
 *  Sharing the constant for the common case keeps every existing capture
 *  identical. The widened string is built by substituting the new geometry
 *  into SERVER_ARGS rather than rebuilt from a literal, so a flag later added
 *  to that constant (screen number, colour depth, `-s`, `-noreset`) carries
 *  over into a widened run too. */
export function serverArgsFor(size: Size | null): string {
  if (size === null) return SERVER_ARGS;
  const margin = 80;
  if (size.width + margin <= SHARED_SCREEN.width && size.height + margin <= SHARED_SCREEN.height) {
    return SERVER_ARGS;
  }
  const w = Math.max(SHARED_SCREEN.width, size.width + margin);
  const h = Math.max(SHARED_SCREEN.height, size.height + margin);
  return SERVER_ARGS.replace(/\d+x\d+x(\d+)/, `${w}x${h}x$1`);
}

/** WIDTH and HEIGHT out of `xdotool getwindowgeometry --shell`'s
 *  `KEY=value` lines. Pure, so the read-back this rig makes of the window it
 *  just opened is testable without a display. Throws if either key is
 *  missing: a shape xdotool did not actually produce should not be read as
 *  "the window opened at 0x0". */
export function parseGeometry(shellOutput: string): Size {
  const width = /^WIDTH=(\d+)$/m.exec(shellOutput);
  const height = /^HEIGHT=(\d+)$/m.exec(shellOutput);
  if (width === null || height === null) {
    throw new Error(`no WIDTH=/HEIGHT= in getwindowgeometry output: "${shellOutput}"`);
  }
  return { width: Number(width[1]), height: Number(height[1]) };
}
