// app/ui/src/measure/workload.ts
// Seeded action script. Deterministic for a seed so two runs compare, and
// shuffled so typing, paragraph edits and navigation interleave the way they
// would in use rather than running as clean phases per kind.
export type ActionKind = "type" | "nav" | "break" | "caret" | "erase";

export interface Action {
  kind: ActionKind;
  /** type only. */
  char?: string;
  /** nav only. */
  key?: string;
  /** caret only: a fixed-range draw the editor wraps onto the live paragraph
   *  count, so the document can grow under it without the draw going stale. */
  index?: number;
}

/** What the soak loop must do about an action, as data rather than as comments.
 *  Record<ActionKind, ...> is the point: a sixth kind added later fails to
 *  compile until its effects are declared, so an omission is a build error and
 *  not a silent default. */
export interface ActionEffects {
  /** Which sample bucket the timing lands in. All editor kinds share "typing",
   *  so typing_p95_ms keeps meaning "the cost of one keystroke". */
  readonly measuredAs: "typing" | "nav";
  /** Whether it can change the document, and so whether it may arm the flush
   *  debounce. A flush with no edit behind it makes flush_count and
   *  flush_p95_ms dishonest, and both are graded. */
  readonly mutatesDocument: boolean;
  /** Whether it advances charsTyped, the onset tracker's x-axis. */
  readonly countsAsCharacter: boolean;
}

export const ACTION_EFFECTS: Record<ActionKind, ActionEffects> = {
  type: { measuredAs: "typing", mutatesDocument: true, countsAsCharacter: true },
  break: { measuredAs: "typing", mutatesDocument: true, countsAsCharacter: false },
  erase: { measuredAs: "typing", mutatesDocument: true, countsAsCharacter: false },
  caret: { measuredAs: "typing", mutatesDocument: false, countsAsCharacter: false },
  nav: { measuredAs: "nav", mutatesDocument: false, countsAsCharacter: false },
};

export interface WorkloadShape {
  typingChars: number;
  navJumps: number;
}

// ArrowLeft and ArrowRight collapse and expand. They were absent through the
// navigator and hierarchy slices, so every graded run to date measured a tree
// that never changed shape under load.
const NAV_KEYS = [
  "ArrowDown",
  "ArrowUp",
  "PageDown",
  "PageUp",
  "Home",
  "End",
  "ArrowLeft",
  "ArrowRight",
] as const;
const TYPE_CHARS = "abcdefghijklmnopqrstuvwxyz ";

// A stated modelling choice, not a measurement: roughly a paragraph every sixty
// characters, a correction every twenty-five, a revision jump every two hundred.
// Named constants so a later change to the workload's shape is a visible change
// rather than a drift, and derived from typingChars rather than read from the
// environment — typing_chars, nav_jumps and action_delay_ms are still raw
// interpolation into the page's init script, and three more knobs would be three
// more ways to lose a run to a typo.
const CHARS_PER_BREAK = 60;
const CHARS_PER_ERASE = 25;
const CHARS_PER_CARET = 200;
const CARET_INDEX_RANGE = 4096;

/** Names the shape of the script, not the harness that ran it. Recorded in every
 *  result so a run from before this workload existed can never be silently
 *  compared against one after it. */
export const WORKLOAD_SCRIPT = "writing-v1";

// xmur3 + mulberry32: a small, well-known seeded PRNG pair. Deterministic
// across runs and platforms, which is the only property required here.
function seeded(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// `count` is accepted for signature stability with a later variant that jumps
// to specific indices; it is unused today.
export function buildWorkload(seed: string, count: number, shape: WorkloadShape): Action[] {
  const rand = seeded(seed);
  const script: Action[] = [];

  for (let i = 0; i < shape.typingChars; i++) {
    script.push({ kind: "type", char: TYPE_CHARS[Math.floor(rand() * TYPE_CHARS.length)]! });
  }
  for (let i = 0; i < shape.navJumps; i++) {
    script.push({ kind: "nav", key: NAV_KEYS[Math.floor(rand() * NAV_KEYS.length)]! });
  }

  for (let i = 0; i < Math.ceil(shape.typingChars / CHARS_PER_BREAK); i++) {
    script.push({ kind: "break" });
  }
  for (let i = 0; i < Math.ceil(shape.typingChars / CHARS_PER_ERASE); i++) {
    script.push({ kind: "erase" });
  }
  for (let i = 0; i < Math.ceil(shape.typingChars / CHARS_PER_CARET); i++) {
    script.push({ kind: "caret", index: Math.floor(rand() * CARET_INDEX_RANGE) });
  }

  // Fisher-Yates, seeded.
  for (let i = script.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [script[i], script[j]] = [script[j]!, script[i]!];
  }
  return script;
}
