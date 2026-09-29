import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createSectionMovePrompt } from "../src/section-move-prompt";

test("the section warning names the destination and cancel leaves the move refused", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const prompt = createSectionMovePrompt(container);
  const pending = prompt.open("Chapter 1", { count: 2, from: "body", to: "front" });
  const dialog = container.querySelector<HTMLDialogElement>("#section-move-prompt");
  expect(dialog?.textContent).toContain("2 items");
  expect(dialog?.textContent).toContain("front matter");
  const cancel = dialog?.querySelector<HTMLButtonElement>("button");
  cancel?.click();
  expect(await pending).toBe(false);
  const singular = prompt.open("Chapter 1", { count: 1, from: "body", to: "front" });
  expect(dialog?.textContent).toContain("1 item.");
  cancel?.click();
  expect(await singular).toBe(false);
  const collateral = prompt.open("Chapter 1", { count: 1, from: "body", to: "body" });
  expect(dialog?.textContent).toContain("1 other item.");
  cancel?.click();
  expect(await collateral).toBe(false);
  prompt.destroy();
  container.remove();
});
