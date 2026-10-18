import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, test } from "bun:test";
if (typeof document === "undefined") GlobalRegistrator.register();
import { askUpgrade } from "../src/upgrade-prompt";

test.each(["cancel", "accept", "escape"])("upgrade consent resolves through the app dialog: %s", async choice => {
  const result = askUpgrade("Older apps cannot open the upgraded book.", "Cancel", "Upgrade book");
  const dialog = document.querySelector<HTMLDialogElement>("dialog.upgrade-prompt")!;
  expect(dialog.open).toBe(true);
  expect(dialog.getAttribute("aria-label")).toBe("Upgrade book");
  const buttons = dialog.querySelectorAll<HTMLButtonElement>("button");
  expect(buttons[0].autofocus).toBe(true);
  if (choice === "escape") dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
  else buttons[choice === "accept" ? 1 : 0].click();
  expect(await result).toBe(choice === "accept");
  expect(dialog.isConnected).toBe(false);
});
