// The banner's tones and its Details disclosure (236).
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createBanner } from "../src/banner";
import { HostCommandError } from "../src/command-error";
import { t } from "../src/i18n";

const IDS = ["open-error", "persist-error"];
const banners = createBanner();
afterEach(() => banners.destroy(IDS));

test("success is the neutral surface with a check mark, and it goes away on its own", () => {
  banners.raise("open-error", "Review copy saved.", "success");
  const el = document.getElementById("open-error")!;
  expect(el.dataset.tone).toBe("success");
  expect(el.getAttribute("role")).toBe("status");
  expect(el.getAttribute("aria-label")).toBe("Review copy saved.");
  const icon = el.querySelector(".app-banner-icon svg");
  expect(icon?.getAttribute("aria-hidden")).toBe("true");
  expect(el.querySelector(".app-banner-dismiss")).not.toBeNull();
  expect(el.querySelector("details")).toBeNull();
});

test("a problem and a failure carry no check mark", () => {
  banners.raise("open-error", "Could not open that.", "problem");
  banners.raise("persist-error", "Not saved.", "failure");
  expect(document.querySelector(".app-banner-icon")).toBeNull();
});

test("a host diagnostic goes behind Details, and a failure stays an undismissable alert", () => {
  const error = new HostCommandError("doc_flush", { version: 1, code: "operation_failed", operation: "doc_flush", detail: "database or disk is full" });
  banners.raise("persist-error", `Not saved: ${error.message}`, "failure");
  const el = document.getElementById("persist-error")!;
  expect(el.getAttribute("role")).toBe("alert");
  expect(el.querySelector(".app-banner-dismiss")).toBeNull();
  expect(el.getAttribute("aria-label")).toBe(`Not saved: ${t("host-error.disk-full")}`);
  expect(el.querySelector(".app-banner-text")?.textContent).not.toContain("database or disk is full");
  const details = el.querySelector("details")!;
  expect(details.open).toBe(false);
  // A native summary: a keyboard stop with no script behind it.
  expect(details.querySelector("summary")?.textContent).toBe(t("banner.details"));
  expect(details.querySelector("code")?.textContent).toBe("database or disk is full");
});

test("an explicit detail is used as given", () => {
  banners.raise("open-error", "Could not open that.", "problem", "raw words");
  expect(document.querySelector("#open-error details code")?.textContent).toBe("raw words");
  banners.raise("open-error", "Could not open that.", "problem", "");
  expect(document.querySelector("#open-error details")).toBeNull();
});

test("the banner publishes its height so the Library can start below it (238)", () => {
  // On Element, as save-indicator.test.ts stubs it: a copy left on
  // HTMLElement.prototype would shadow every later Element stub.
  const real = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    return { height: this.classList.contains("app-banner") ? 37.4 : 0 } as DOMRect;
  };
  try {
    const root = document.documentElement;
    banners.raise("open-error", "Could not open that.", "problem");
    expect(root.style.getPropertyValue("--banner-h")).toBe("38px");
    document.querySelector<HTMLButtonElement>("#open-error .app-banner-dismiss")!.click();
    expect(root.style.getPropertyValue("--banner-h")).toBe("0px");
  } finally {
    Element.prototype.getBoundingClientRect = real;
  }
});
