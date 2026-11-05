// app/ui/src/state-mark.ts
// The mark a revision state wears, drawn rather than typed. At the navigator's
// 13px the four fill characters read as one dark smudge, so each state gets a
// shape of its own: a ring, a half, a solid disc, and the disc with a tick for
// done. All four paint in currentColor, so the palette, the theme and forced
// colors reach them through `color` alone.

import type { RevisionState } from "./revision-states";

const SVG_NS = "http://www.w3.org/2000/svg";

type Shape = readonly [tag: "circle" | "path", attrs: Readonly<Record<string, string>>];

const RING: Shape = ["circle", { cx: "6", cy: "6", r: "4.75", fill: "none", stroke: "currentColor", "stroke-width": "1.5" }];

// The tick is a hole in the disc (even-odd), not a second colour: a stroke in
// the surface colour would have to know which surface the mark sits on.
const SHAPES: Record<RevisionState, readonly Shape[]> = {
  outline: [RING],
  draft: [RING, ["path", { d: "M6 1.25A4.75 4.75 0 0 0 6 10.75Z", fill: "currentColor" }]],
  revising: [["circle", { cx: "6", cy: "6", r: "5.5", fill: "currentColor" }]],
  done: [["path", {
    d: "M6 0.5A5.5 5.5 0 1 1 6 11.5A5.5 5.5 0 1 1 6 0.5Z"
      + "M2.70 6.70L5.22 9.22L9.32 4.88L8.08 3.72L5.18 6.78L3.90 5.50Z",
    fill: "currentColor",
    "fill-rule": "evenodd",
  }]],
};

/** A fresh mark for `state`. Decorative: the caller's label or description
 *  says the word. */
export function createStateMark(state: RevisionState): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("state-shape");
  for (const [tag, attrs] of SHAPES[state]) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    svg.append(node);
  }
  return svg;
}

/** Paint `state`'s mark into `host`, or empty it for no state. A no-op when the
 *  host already shows that state, so a repaint of a recycled row costs an
 *  attribute read. `data-mark` names what is drawn. */
export function paintStateMark(host: HTMLElement, state: RevisionState | null): void {
  if ((host.dataset.mark ?? null) === state) return;
  if (state === null) {
    host.replaceChildren();
    delete host.dataset.mark;
    return;
  }
  host.replaceChildren(createStateMark(state));
  host.dataset.mark = state;
}
