// app/ui/src/preflight-panel.ts
// What an export of this book would carry, and what each check does and does
// not prove.
//
// It reports and can record a reason for a current warning. There is no Export
// on it and no override:
// a cross-identity finding BLOCKS and cannot be dismissed, which is section 8's
// wording, and the two ways past it are both real work -- edit the manuscript at
// the place this report names, or pin the identity the name belongs to.
//
// ITS DISMISS CONTROL IS AT THE TOP. Every other panel in this application holds
// nothing that can grow, and 040 recorded why: a list that grows pushes the
// controls under the fold. This report DOES grow -- one row per finding, one per
// surface -- so its dismiss control stays above the lists, and the panel scrolls.
// That is the only place in this application
// where scrolling is the answer, and it is because the alternative is a report
// that hides its own findings.
//
// EVERY WORD IN IT COMES FROM THE CATALOG. The host answers in machine words --
// check names, states, surfaces, finding kinds, field places -- and this file
// looks each one up. The one sentence the host composes is the refusal an export
// answers with when it is blocked, which is an error and goes through the notice
// surface like every other host error.
//
// AND THE SENTENCE ABOUT WHAT WAS COMPARED IS FIXED BY THE DESIGN: no occurrence
// of a known other-identity name was found in the surfaces listed. Never "no
// leaks". A check that overstates what it proves is worse than no check, because
// a writer acts on it.
import { formatDateTime, t } from "./i18n";
import { createPanelShell } from "./panel-shell";
import {
  checkName,
  warningKindName,
  checkStateName,
  crossIdentityClaim,
  fieldRow,
  findingSentence,
  formatName,
  severityName,
  surfaceName,
  type Preflight,
} from "./identity";

export interface PreflightPanelDeps {
  readonly container: HTMLElement;
  /** What an export in `format` would be checked for. It does not export and it
   *  does not render: a blocker stops a render, so the only way a writer can
   *  read the report of an export that would be refused is a path that does not
   *  attempt one. */
  read(format: string): Promise<Preflight>;
  append(format: string, token: string, reason: string): Promise<Preflight>;
  onNotice(message: string): void;
  onDismiss(): void;
}

export interface PreflightPanel {
  open(format: string): Promise<void>;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createPreflightPanel(deps: PreflightPanelDeps): PreflightPanel {
  const { container } = deps;

  const panel = document.createElement("div");
  panel.id = "preflight-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", t("preflight.panel.label"));
  panel.tabIndex = -1;
  panel.hidden = true;

  const body = document.createElement("div");
  body.id = "preflight-body";

  panel.append(body);
  container.append(panel);

  // Close, Escape and a click elsewhere (the shell's). THE CONTROL STAYS AT THE
  // TOP: this is the one panel here whose lists grow, and the shell's body is
  // what scrolls, so nothing a writer has to press sits under them. The title
  // names the format once a report is painted; Close keeps one fixed name.
  const shell = createPanelShell({
    panel,
    title: t("preflight.heading"),
    name: t("preflight.heading"),
    titleId: "preflight-heading",
    closeId: "preflight-close",
    close: () => close(),
    returnFocus: deps.onDismiss,
  });
  const heading = shell.title;

  let destroyed = false;
  let generation = 0;
  let currentReport: Preflight | null = null;
  let pending = false;
  const drafts = new Map<string, string>();

  function section(id: string, title: string): HTMLElement {
    const block = document.createElement("section");
    block.className = "preflight-section";
    block.dataset.preflightSection = id;
    const caption = document.createElement("h3");
    caption.textContent = title;
    block.append(caption);
    return block;
  }

  function line(text: string, className: string): HTMLElement {
    const p = document.createElement("p");
    p.className = className;
    p.textContent = text;
    return p;
  }

  function paint(report: Preflight): void {
    currentReport = report;
    heading.textContent = t("preflight.heading.of", { format: formatName(report.format) });
    body.replaceChildren();

    // 1. What this format writes. The SAME table the writer iterates: if the
    //    two were separate lists the check would be theatre.
    const fields = section("fields", t("preflight.fields.heading"));
    if (report.fields.length === 0) {
      // A TRUE AND USEFUL STATEMENT rather than an empty block: it tells a
      // writer that the byline they believe they are exporting is not in the
      // file.
      fields.append(line(t("preflight.fields.none"), "preflight-note"));
    } else {
      for (const field of report.fields) {
        fields.append(line(fieldRow(field), "preflight-field"));
      }
    }
    body.append(fields);

    // 2. Findings, before the checks: what was found is what a writer came for.
    const findings = section("findings", t("preflight.findings.heading"));
    if (report.findings.length === 0) {
      findings.append(line(t("preflight.findings.none"), "preflight-note"));
    } else {
      for (const [index, finding] of report.findings.entries()) {
        const row = document.createElement("div");
        row.className = "preflight-finding";
        row.dataset.preflightSeverity = finding.severity;
        const description = document.createElement("p");
        const tag = document.createElement("span");
        tag.className = "preflight-severity";
        tag.textContent = severityName(finding.severity);
        description.append(tag, document.createTextNode(` ${findingSentence(finding)}`));
        row.append(description);
        const warning = report.warning_tokens.find((item) => item.finding_index === index);
        if (finding.severity === "warning" && warning && report.reason_history.state === "available") {
          const label = document.createElement("label");
          label.className = "preflight-reason-label";
          label.textContent = t("preflight.reason.label");
          const input = document.createElement("textarea");
          input.id = `preflight-reason-input-${index}`;
          input.className = "preflight-reason-input";
          input.dataset.preflightToken = warning.token;
          input.maxLength = 500;
          input.rows = 2;
          input.value = drafts.get(warning.token) ?? "";
          label.append(input);
          const record = document.createElement("button");
          record.id = `preflight-reason-record-${index}`;
          record.type = "button";
          record.dataset.preflightAction = "record";
          record.dataset.preflightToken = warning.token;
          record.textContent = t("preflight.reason.record");
          record.disabled = pending;
          row.append(label, record);
        }
        findings.append(row);
      }
    }
    body.append(findings);

    const history = section("history", t("preflight.history.heading"));
    history.append(line(t("preflight.history.context"), "preflight-note"));
    if (report.reason_history.state === "unavailable") {
      history.append(line(t("preflight.history.unavailable"), "preflight-note"));
    } else if (report.reason_history.entries.length === 0) {
      history.append(line(t("preflight.history.none"), "preflight-note"));
    } else {
      for (const entry of report.reason_history.entries) {
        const item = document.createElement("div");
        item.className = "preflight-history-entry";
        const detail = t("preflight.history.entry", {
          check: warningKindName(entry.check),
          format: formatName(entry.format),
          surface: surfaceName(entry.surface),
          at: formatDateTime(entry.at_ms),
        });
        item.append(line(detail, "preflight-history-detail"), line(entry.reason, "preflight-history-reason"));
        history.append(item);
      }
    }
    body.append(history);

    // 3. Every check and what it did.
    const checks = section("checks", t("preflight.checks.heading"));
    for (const check of report.checks) {
      const row = document.createElement("p");
      row.className = "preflight-check";
      row.dataset.preflightCheck = check.name;
      row.dataset.preflightState = check.state;
      row.textContent = t("preflight.check.row", {
        name: checkName(check.name),
        state: checkStateName(check.state),
      });
      checks.append(row);
    }
    body.append(checks);

    // 4. THE SKIPPED HEADING. A preflight that shows six rows and hides that
    //    four of them checked nothing is the recorded failure mode this
    //    repository already has a name for. Listed again, by name, under a
    //    heading of their own -- not merely marked in the list above.
    const skipped = section("skipped", t("preflight.skipped.heading"));
    if (report.skipped.length === 0) {
      skipped.append(line(t("preflight.skipped.none"), "preflight-note"));
    } else {
      for (const name of report.skipped) {
        skipped.append(line(checkName(name), "preflight-skipped"));
      }
    }
    body.append(skipped);

    // 5. What was compared, what was not, and the sentence that says exactly
    //    what the comparison proves.
    const surfaces = section("surfaces", t("preflight.surfaces.checked"));
    surfaces.append(line(crossIdentityClaim(report), "preflight-claim"));
    for (const surface of report.surfaces_checked) {
      surfaces.append(line(surfaceName(surface), "preflight-surface"));
    }
    const unchecked = document.createElement("h4");
    unchecked.textContent = t("preflight.surfaces.unchecked");
    surfaces.append(unchecked);
    for (const surface of report.surfaces_unchecked) {
      surfaces.append(line(surfaceName(surface), "preflight-unchecked"));
    }
    body.append(surfaces);
  }

  const onPanelClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const record = target.closest<HTMLButtonElement>("[data-preflight-action='record']");
    if (record !== null) void recordReason(record);
  };

  const onPanelInput = (event: Event): void => {
    const input = event.target;
    if (input instanceof HTMLTextAreaElement && input.dataset.preflightToken) {
      drafts.set(input.dataset.preflightToken, input.value);
    }
  };

  async function recordReason(button: HTMLButtonElement): Promise<void> {
    if (pending || currentReport === null) return;
    const token = button.dataset.preflightToken;
    if (!token || !currentReport.warning_tokens.some((item) => item.token === token)) return;
    const reason = drafts.get(token) ?? "";
    if (reason.trim().length === 0) {
      deps.onNotice(t("preflight.reason.empty"));
      return;
    }
    const mine = generation;
    const format = currentReport.format;
    pending = true;
    button.disabled = true;
    try {
      const next = await deps.append(format, token, reason);
      if (destroyed || mine !== generation) return;
      if (drafts.get(token) === reason) drafts.delete(token);
      pending = false;
      paint(next);
      body.querySelector<HTMLTextAreaElement>(`.preflight-reason-input[data-preflight-token='${token}']`)?.focus();
    } catch (error: unknown) {
      if (destroyed || mine !== generation) return;
      pending = false;
      button.disabled = false;
      deps.onNotice(t("preflight.reason.error", { error: messageOf(error) }));
      body.querySelector<HTMLTextAreaElement>(`.preflight-reason-input[data-preflight-token='${token}']`)?.focus();
    }
  }

  function close(): void {
    generation += 1;
    pending = false;
    currentReport = null;
    drafts.clear();
    panel.hidden = true;
    // The report goes with it. It holds the writer's own prose around every
    // match it found.
    body.replaceChildren();
  }

  panel.addEventListener("click", onPanelClick);
  panel.addEventListener("input", onPanelInput);

  return {
    async open(format: string): Promise<void> {
      generation += 1;
      const mine = generation;
      pending = false;
      currentReport = null;
      drafts.clear();
      panel.hidden = false;
      panel.focus();
      try {
        const report = await deps.read(format);
        if (destroyed || mine !== generation) return;
        paint(report);
      } catch (error: unknown) {
        if (destroyed || mine !== generation) return;
        // NOT AN EMPTY REPORT. A catch that painted "nothing was found" would
        // report a check that could not run as a check that found nothing,
        // which is the whole failure this slice is about.
        deps.onNotice(t("preflight.error.load", { error: messageOf(error) }));
        close();
      }
    },
    close,
    isOpen(): boolean {
      return !panel.hidden;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      panel.removeEventListener("click", onPanelClick);
      panel.removeEventListener("input", onPanelInput);
      shell.destroy();
      container.replaceChildren();
    },
  };
}
