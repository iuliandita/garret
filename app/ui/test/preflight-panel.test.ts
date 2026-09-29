import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createPreflightPanel, type PreflightPanel } from "../src/preflight-panel";
import type { Preflight } from "../src/identity";
import { EN } from "../src/i18n";

function report(over: Partial<Preflight> = {}): Preflight {
  return {
    format: "markdown",
    identity: null,
    fields: [],
    checks: [
      { name: "identity_disclosure", state: "ran" },
      { name: "cross_identity", state: "not_applicable" },
      { name: "missing_metadata", state: "vacuous" },
      { name: "broken_links", state: "vacuous" },
      { name: "validator", state: "not_applicable" },
      { name: "assets", state: "not_applicable" },
    ],
    skipped: ["cross_identity", "missing_metadata", "broken_links", "validator", "assets"],
    findings: [],
    surfaces_checked: ["project_name", "item_title", "document_body"],
    surfaces_unchecked: ["comment_body", "readable_mirror"],
    blockers: 0,
    warning_tokens: [],
    reason_history: { state: "available", entries: [] },
    ...over,
  };
}

interface Rig {
  panel: PreflightPanel;
  container: HTMLElement;
  answer: Preflight | "fail";
  asked: string[];
  notices: string[];
  dismissed: number;
  appended: { format: string; token: string; reason: string }[];
  appendAnswer: ((format: string, token: string, reason: string) => Promise<Preflight>) | null;
  teardown(): void;
}

function mount(): Rig {
  const container = document.createElement("span");
  document.body.append(container);
  const rig: Partial<Rig> & { container: HTMLElement } = {
    container,
    answer: report(),
    asked: [],
    notices: [],
    dismissed: 0,
    appended: [],
    appendAnswer: null,
  };
  rig.panel = createPreflightPanel({
    container,
    read: async (format) => {
      rig.asked?.push(format);
      if (rig.answer === "fail") throw new Error("boom");
      return rig.answer as Preflight;
    },
    append: async (format, token, reason) => {
      rig.appended?.push({ format, token, reason });
      return rig.appendAnswer ? rig.appendAnswer(format, token, reason) : rig.answer as Preflight;
    },
    onNotice: (m) => rig.notices?.push(m),
    onDismiss: () => {
      rig.dismissed = (rig.dismissed ?? 0) + 1;
    },
  });
  rig.teardown = (): void => {
    rig.panel?.destroy();
    container.remove();
  };
  return rig as Rig;
}

let live: Rig | null = null;
afterEach(() => {
  live?.teardown();
  live = null;
});

const textOf = (rig: Rig, selector: string): string =>
  rig.container.querySelector(selector)?.textContent ?? "";

describe("the export report", () => {
  const warning = {
    kind: "identity_unset", severity: "warning", surface: "project",
    item_id: null, offset: null, matched: "",
  };

  test("a warning can record a reason while the warning and blocker verdict remain visible", async () => {
    const rig = (live = mount());
    const initial = report({ findings: [warning], warning_tokens: [{ finding_index: 0, token: "0123456789abcdef" }] });
    rig.answer = initial;
    rig.appendAnswer = async () => report({
      ...initial,
      reason_history: { state: "available", entries: [{
        check: "identity_unset", format: "markdown", surface: "project", item_id: null,
        offset: null, fingerprint: "0123456789abcdef", reason: "The byline is intentionally blank.", at_ms: 1_700_000_000_000,
      }] },
    });
    await rig.panel.open("markdown");
    const input = rig.container.querySelector<HTMLTextAreaElement>(".preflight-reason-input")!;
    input.value = "The byline is intentionally blank.";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    rig.container.querySelector<HTMLButtonElement>("[data-preflight-action='record']")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rig.appended).toEqual([{ format: "markdown", token: "0123456789abcdef", reason: "The byline is intentionally blank." }]);
    expect(textOf(rig, ".preflight-history-reason")).toBe("The byline is intentionally blank.");
    expect(textOf(rig, ".preflight-history-detail")).toContain(EN["preflight.history.kind.identity_unset"]);
    expect(rig.container.querySelector<HTMLElement>(".preflight-finding")?.dataset.preflightSeverity).toBe("warning");
    expect(textOf(rig, "[data-preflight-section='history'] .preflight-note")).toContain("do not clear");
  });

  test("a pending or failed append preserves a newly typed draft and cannot duplicate the request", async () => {
    const rig = (live = mount());
    rig.answer = report({ findings: [warning], warning_tokens: [{ finding_index: 0, token: "0123456789abcdef" }] });
    let reject!: (error: Error) => void;
    rig.appendAnswer = () => new Promise((_resolve, no) => { reject = no; });
    await rig.panel.open("markdown");
    const input = rig.container.querySelector<HTMLTextAreaElement>(".preflight-reason-input")!;
    input.value = "First draft";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const button = rig.container.querySelector<HTMLButtonElement>("[data-preflight-action='record']")!;
    button.click();
    button.click();
    expect(rig.appended.length).toBe(1);
    input.value = "Revised draft";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    reject(new Error("storage failed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(input.value).toBe("Revised draft");
    expect(button.disabled).toBe(false);
    expect(rig.notices.at(-1)).toContain("storage failed");
  });

  test("a blocker has no reason control and unreadable history is named", async () => {
    const rig = (live = mount());
    rig.answer = report({ findings: [{ ...warning, severity: "blocker" }], blockers: 1,
      reason_history: { state: "unavailable" } });
    await rig.panel.open("markdown");
    expect(rig.container.querySelector(".preflight-reason-input")).toBeNull();
    expect(textOf(rig, "[data-preflight-section='history']")).toContain(EN["preflight.history.unavailable"]);
  });

  test("a format that writes no identity field says so rather than showing an empty block", async () => {
    // A TRUE AND USEFUL STATEMENT: it tells a writer that the byline they think
    // they are exporting is not in the file.
    const rig = (live = mount());
    await rig.panel.open("markdown");
    expect(rig.asked).toEqual(["markdown"]);
    expect(textOf(rig, "[data-preflight-section='fields'] .preflight-note")).toBe(
      EN["preflight.fields.none"],
    );
  });

  test("the fields it does write are listed with where each one lands", async () => {
    const rig = (live = mount());
    rig.answer = report({
      format: "epub",
      fields: [
        { field: "name", at: "dc:creator", value: "Ada Vane" },
        { field: "imprint", at: "dc:publisher", value: "Vane Press" },
      ],
    });
    await rig.panel.open("epub");
    const rows = [...rig.container.querySelectorAll(".preflight-field")].map((n) => n.textContent);
    expect(rows.length).toBe(2);
    expect(rows[0]).toContain("Ada Vane");
    expect(rows[0]).toContain(EN["preflight.at.dc:creator"]);
    expect(textOf(rig, "#preflight-heading")).toContain(EN["preflight.format.epub"]);
  });

  test("every check that did not run is listed AGAIN under its own heading", async () => {
    // THE RECORDED FAILURE MODE. A preflight showing six rows and hiding that
    // four of them checked nothing is what this heading exists to refuse -- and
    // it is a second list, not a marking in the first, because a reader skims
    // headings.
    const rig = (live = mount());
    await rig.panel.open("markdown");
    const skipped = [...rig.container.querySelectorAll(".preflight-skipped")].map(
      (n) => n.textContent,
    );
    expect(skipped).toEqual([
      EN["preflight.check.cross_identity"],
      EN["preflight.check.missing_metadata"],
      EN["preflight.check.broken_links"],
      EN["preflight.check.validator"],
      EN["preflight.check.assets"],
    ]);
    // The one that DID run is not in it, or the heading is a list of every check
    // there is.
    expect(skipped).not.toContain(EN["preflight.check.identity_disclosure"]);
  });

  test("a report where every check ran says so instead of an empty heading", async () => {
    const rig = (live = mount());
    rig.answer = report({
      skipped: [],
      checks: report().checks.map((c) => ({ ...c, state: "ran" })),
    });
    await rig.panel.open("markdown");
    expect(textOf(rig, "[data-preflight-section='skipped'] .preflight-note")).toBe(
      EN["preflight.skipped.none"],
    );
  });

  test("a blocker and a warning are told apart in the markup", async () => {
    // A report that painted both the same would make a writer read every line
    // to find the one that stopped their book.
    const rig = (live = mount());
    rig.answer = report({
      blockers: 1,
      findings: [
        {
          kind: "identity_unset",
          severity: "warning",
          surface: "project",
          item_id: null,
          offset: null,
          matched: "",
        },
        {
          kind: "cross_identity",
          severity: "blocker",
          surface: "document_body",
          item_id: "s2",
          offset: 9,
          matched: "Bram Kell",
        },
      ],
    });
    await rig.panel.open("markdown");
    const rows = [...rig.container.querySelectorAll<HTMLElement>(".preflight-finding")];
    expect(rows.map((n) => n.dataset.preflightSeverity)).toEqual(["warning", "blocker"]);
    expect(rows[1]?.textContent).toContain("Bram Kell");
    expect(rows[1]?.textContent).toContain("s2");
  });

  test("with nothing to compare against, the claim says so and is not the strong one", async () => {
    // "I had nothing to compare against" and "there is nothing to find" are
    // different answers, and the report must never spell them the same way.
    const rig = (live = mount());
    await rig.panel.open("markdown");
    expect(textOf(rig, ".preflight-claim")).toBe(EN["preflight.surfaces.nothing"]);
  });

  test("with something to compare against, the claim is about an occurrence and not a leak", async () => {
    const rig = (live = mount());
    rig.answer = report({
      checks: report().checks.map((c) =>
        c.name === "cross_identity" ? { ...c, state: "ran" } : c,
      ),
      skipped: ["missing_metadata", "broken_links", "validator", "assets"],
    });
    await rig.panel.open("markdown");
    const claim = textOf(rig, ".preflight-claim");
    expect(claim).toBe(EN["preflight.surfaces.claim"]);
    expect(claim).toContain("occurrence");
    expect(claim.toLowerCase()).not.toContain("leak");
  });

  test("the surfaces it did not read are named rather than omitted", async () => {
    const rig = (live = mount());
    await rig.panel.open("markdown");
    const checked = [...rig.container.querySelectorAll(".preflight-surface")].map(
      (n) => n.textContent,
    );
    const unchecked = [...rig.container.querySelectorAll(".preflight-unchecked")].map(
      (n) => n.textContent,
    );
    expect(checked).toEqual([
      EN["preflight.surface.project_name"],
      EN["preflight.surface.item_title"],
      EN["preflight.surface.document_body"],
    ]);
    expect(unchecked).toEqual([
      EN["preflight.surface.comment_body"],
      EN["preflight.surface.readable_mirror"],
    ]);
  });

  test("a check that could not run raises a notice and does NOT paint a clean report", async () => {
    // A catch that painted "nothing was found" would report a check that could
    // not run as a check that found nothing, which is the whole failure this
    // slice is about.
    const rig = (live = mount());
    rig.answer = "fail";
    await rig.panel.open("markdown");
    expect(rig.notices.length).toBe(1);
    expect(rig.notices[0]).toContain("boom");
    expect(rig.panel.isOpen()).toBe(false);
    expect(rig.container.querySelectorAll(".preflight-section").length).toBe(0);
  });

  test("Close and Escape both dismiss it and hand focus back", async () => {
    const rig = (live = mount());
    await rig.panel.open("markdown");
    rig.container
      .querySelector("#preflight-close")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(rig.panel.isOpen()).toBe(false);
    expect(rig.dismissed).toBe(1);
    await rig.panel.open("markdown");
    rig.container
      .querySelector("#preflight-panel")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(rig.panel.isOpen()).toBe(false);
    expect(rig.dismissed).toBe(2);
  });

  test("closing lets go of the report, which holds the writer's own prose", async () => {
    const rig = (live = mount());
    rig.answer = report({
      findings: [
        {
          kind: "cross_identity",
          severity: "blocker",
          surface: "document_body",
          item_id: "s2",
          offset: 9,
          matched: "Bram Kell",
        },
      ],
      blockers: 1,
    });
    await rig.panel.open("markdown");
    expect(rig.container.querySelectorAll(".preflight-finding").length).toBe(1);
    rig.panel.close();
    expect(rig.container.querySelector("#preflight-body")?.childElementCount).toBe(0);
  });
});
