import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";
import { createHelpTip } from "../src/help-tip";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

const rect = (left: number, right: number): DOMRect => new DOMRect(left, 0, right - left, 30);

describe("help definition placement", () => {
  for (const [anchorLeft, expectedLeft, event] of [[700, 696, "mouseenter"], [980, 696, "focus"], [650, 654, "mouseenter"]] as const) {
    test(`keeps the whole definition inside the panel at ${anchorLeft} on ${event}`, () => {
      const panel = document.createElement("div");
      panel.style.overflowX = "auto";
      panel.getBoundingClientRect = () => rect(650, 1000);
      const help = createHelpTip({ label: "Words", definition: "Saved words in this scene." });
      help.anchor.getBoundingClientRect = () => rect(anchorLeft, anchorLeft + 16);
      panel.append(help.anchor);
      document.body.append(panel);
      const original = HTMLElement.prototype.getBoundingClientRect;
      HTMLElement.prototype.getBoundingClientRect = function () {
        return this.classList.contains("tip") ? rect(0, 300) : original.call(this);
      };
      try {
        help.button.dispatchEvent(event === "focus" ? new FocusEvent(event) : new MouseEvent(event));
        const tip = help.anchor.querySelector<HTMLElement>(".tip")!;
        expect(Number.parseFloat(tip.style.left) + anchorLeft).toBe(expectedLeft);
        expect(tip.style.maxWidth).toBe("300px");
        expect(tip.hidden).toBe(false);
      } finally {
        HTMLElement.prototype.getBoundingClientRect = original;
        help.destroy();
        panel.remove();
      }
    });
  }
  test("a definition near the scrolling body's bottom opens above its mark", () => {
    const panel = document.createElement("div");
    panel.style.overflowY = "auto";
    panel.getBoundingClientRect = () => new DOMRect(650, 100, 350, 600);
    const help = createHelpTip({ label: "Parts", definition: "Parts in this book." });
    help.anchor.getBoundingClientRect = () => new DOMRect(700, 650, 16, 16);
    panel.append(help.anchor);
    document.body.append(panel);
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return this.classList.contains("tip") ? new DOMRect(0, 0, 300, 60) : original.call(this);
    };
    try {
      help.button.dispatchEvent(new FocusEvent("focus"));
      const tip = help.anchor.querySelector<HTMLElement>(".tip")!;
      expect(Number.parseFloat(tip.style.top) + 650).toBe(584);
      expect(tip.classList.contains("tip-above")).toBe(true);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
      help.destroy();
      panel.remove();
    }
  });

});
