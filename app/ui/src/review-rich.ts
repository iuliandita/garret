import type { FragmentToken } from "./review-fragments";
import { t } from "./i18n";

/** Fragment edges can be open, so show each visible run in a readable paragraph. */
export function reviewRich(tokens: FragmentToken[]): HTMLElement {
  const view = document.createElement("div"); view.className = "review-rich";
  let paragraph: HTMLParagraphElement | null = null;
  for (const token of tokens) {
    if (token.kind === "open") { paragraph = document.createElement("p"); view.append(paragraph); }
    else if (token.kind === "close") {
      if (!paragraph) view.append(document.createElement("p"));
      paragraph = null;
    } else if (token.kind === "atom") {
      if (token.node.type !== "endnote") paragraph = null;
      const payload = document.createElement("code");
      payload.className = "review-atom";
      payload.textContent = JSON.stringify(token.node);
      if (token.node.type === "endnote") {
        if (!paragraph) { paragraph = document.createElement("p"); view.append(paragraph); }
        paragraph.append(payload);
      } else view.append(payload);
    } else if (token.kind === "text") {
      if (!paragraph) { paragraph = document.createElement("p"); view.append(paragraph); }
      let text: Node = document.createTextNode(token.text);
      for (const mark of token.marks ?? []) {
        const wrap = document.createElement(mark === "strong" ? "strong" : mark === "em" ? "em" : "u");
        wrap.append(text); text = wrap;
      }
      paragraph.append(text);
    }
  }
  if (!tokens.length) {
    const empty = document.createElement("p"); empty.textContent = t("review.no-text"); view.append(empty);
  }
  return view;
}
