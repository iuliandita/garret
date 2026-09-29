// app/harness/src/press-selector.ts
// Which control a capture presses, named the way the page names it: by DOM
// id (the `id:` object attribute AT-SPI carries) or by ACCESSIBLE NAME,
// which is the only channel certain to survive for a per-row control that
// has no id of its own. Pure, so "exactly one match" is a tested rule and
// not a hope.
import type { Node } from "./nodes";
import type { Size } from "./window-size";

export interface PressSelector {
  by: "id" | "name";
  value: string;
}

/** `id:x`, `name:Make an archive`, or bare `x` (an id). Trimmed on both
 *  sides -- a value typed as `--press "id: foo "` means the id `foo`, not an
 *  id with the shell's stray whitespace baked in. A value that is empty
 *  after trimming refuses, so `--press "id:   "` fails loudly rather than
 *  looking for a control whose id is a blank string. */
export function parsePressSelector(text: string): PressSelector {
  const trimmed = text.trim();
  const m = /^(id|name):(.*)$/s.exec(trimmed);
  const [by, rawValue] = m === null ? (["id", trimmed] as const) : ([m[1] as "id" | "name", m[2]!] as const);
  const value = rawValue.trim();
  if (value.length === 0) throw new Error(`--press wants id:<dom-id> or name:<accessible name>, got "${text}"`);
  return { by, value };
}

/** The one node the selector names. Zero matches and several are both
 *  refusals with the candidates spelled out: a press that landed on "the
 *  first of two Adds" would photograph the wrong section and say nothing.
 *
 *  `label` names the caller in the refusal, default "--press" for `shot-cli`'s
 *  own flag; a script with no such flag (`mirror-shot.ts`) passes its own
 *  name instead, so a refusal reads as its own and not as advice to pass a
 *  flag that script does not have. */
export function nodeToPress(nodes: readonly Node[], selector: PressSelector, label = "--press"): Node {
  const hits = nodes.filter((n) => (selector.by === "id" ? n.id === selector.value : n.name === selector.value));
  if (hits.length === 1) return hits[0]!;
  const seen = nodes
    .filter((n) => (selector.by === "id" ? n.id.length > 0 : n.name.length > 0))
    .map((n) => (selector.by === "id" ? n.id : `${n.role} "${n.name}"`));
  if (hits.length === 0) {
    throw new Error(`${label}: no control with ${selector.by} "${selector.value}" in the accessibility tree; ${selector.by}s present: ${seen.join(", ")}`);
  }
  throw new Error(
    `${label}: ${hits.length} controls share ${selector.by} "${selector.value}" (${hits
      .map((n) => `${n.role} at ${n.x},${n.y}, id "${n.id.length > 0 ? n.id : "no id"}"`)
      .join("; ")}); name one`,
  );
}

/** Where a press actually lands: the node's own centre, refused when the node
 *  is not a click target at all. A zero-extent node (collapsed, or scrolled
 *  clean out of a panel and never laid out) has a centre that is a fact
 *  about arithmetic, not about the screen, and clicking it hits whatever
 *  real control happens to sit there. Refused too when that centre falls
 *  outside the window the node was measured in: a stale walk against a
 *  since-resized or since-scrolled window is the same failure by another
 *  route. */
export function pressPoint(node: Node, window: Size): { x: number; y: number } {
  if (node.w <= 0 || node.h <= 0) {
    throw new Error(
      `--press: ${node.role} "${node.name}" has no extent (${node.w}x${node.h}); it is not on screen`,
    );
  }
  const x = Math.round(node.x + node.w / 2);
  const y = Math.round(node.y + node.h / 2);
  if (x < 0 || x >= window.width || y < 0 || y >= window.height) {
    throw new Error(
      `--press: ${node.role} "${node.name}" centres at ${x},${y}, outside the ${window.width}x${window.height} window`,
    );
  }
  return { x, y };
}

/** The tag a default output filename hangs off a press: the selector kind and
 *  a filesystem-safe slug of its value, so two captures pressing different
 *  controls never collide on the same name. Leading and trailing hyphen runs
 *  are stripped -- a value that starts or ends in punctuation ("Who's on
 *  first?") should not leave a dangling `-` at either end of a filename --
 *  and a value that is ALL punctuation slugs to nothing, in which case the
 *  selector kind alone names the file rather than trailing a bare `-`. */
export function pressSlug(selector: PressSelector): string {
  const slug = selector.value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length === 0 ? selector.by : `${selector.by}-${slug}`;
}
