import { t } from "./i18n";

interface Failure {
  version: number;
  code: string;
  operation: string;
  detail: string;
}

function failureOf(value: unknown): Failure | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return record.version === 1 && typeof record.code === "string"
    && typeof record.operation === "string" && typeof record.detail === "string"
    ? record as unknown as Failure : null;
}

function diagnostic(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try { return JSON.stringify(value) ?? String(value); }
  catch { return String(value); }
}

/** The host says `operation_failed` for almost everything, so the class is read
 *  off the diagnostic SQLite and the OS already write. First match wins, and
 *  the order matters: "database or disk is full" must not read as a lock. */
const CLASSES: ReadonlyArray<readonly [string, RegExp]> = [
  // A PICTURE'S REFUSAL FIRST. `pictures.rs` writes each refusal as a
  // sentence meant for the writer, so the generic "please try again" was the
  // wrong headline for all four: trying again refuses the same file the same
  // way. The host's own figures stay behind Details.
  ["host-error.picture-bytes", /the largest picture this book will take is/],
  ["host-error.picture-format", /is not a png or a jpeg/],
  ["host-error.picture-pixels", /the largest this book will read is/],
  ["host-error.picture-unreadable", /^that picture could not be read/],
  ["host-error.corrupt", /database disk image is malformed|file is not a database|sqlite_corrupt|sqlite_notadb/],
  ["host-error.disk-full", /database or disk is full|no space left on device|\(os error 28\)|disk quota exceeded|\(os error 122\)|^disk full|sqlite_full/],
  ["host-error.read-only", /readonly database|read-only file system|\(os error 30\)|sqlite_readonly/],
  ["host-error.busy", /database is locked|database table is locked|database is busy|sqlite_busy|sqlite_locked/],
  ["host-error.io", /disk i\/o error|input\/output error|\(os error 5\)|sqlite_ioerr/],
];

/** The one plain sentence for a host failure: what went wrong and what to do.
 *  Never the raw diagnostic; that is `failureDetail`'s. */
export function failureProblem(value: unknown): string {
  if (value instanceof HostCommandError) return value.problem;
  const failure = failureOf(value);
  if (failure?.code === "application_locked" || value === "application locked") return t("host-error.locked");
  const detail = (failure?.detail ?? diagnostic(value)).toLowerCase();
  const known = CLASSES.find(([, pattern]) => pattern.test(detail));
  return t(known?.[0] ?? "host-error.failed");
}

/** What the host actually reported, for the banner's Details disclosure. */
export function failureDetail(value: unknown): string {
  if (value instanceof HostCommandError) return value.detail;
  return failureOf(value)?.detail ?? diagnostic(value);
}

/** Details this page has recently put into a message, so a banner can lift
 *  exactly that span back out of a sentence a caller built around it. Most
 *  callers wrap the error in their own catalog sentence ("Could not switch to
 *  {path}: {error}. The project you were in is still open."), so the detail
 *  can sit mid-sentence and its end cannot be found by the marker alone. */
const recentDetails: string[] = [];
const RECENT_LIMIT = 32;

function remember(detail: string): void {
  const at = recentDetails.indexOf(detail);
  if (at !== -1) recentDetails.splice(at, 1);
  recentDetails.push(detail);
  if (recentDetails.length > RECENT_LIMIT) recentDetails.shift();
}

export function commandFailureMessage(value: unknown): string {
  const primary = failureProblem(value);
  const detail = failureDetail(value);
  if (detail === "" || isApplicationLocked(value)) return primary;
  remember(detail);
  return t("host-error.with-detail", { primary, detail });
}

/** Split a message into what the banner says and what it keeps behind
 *  Details. Only a detail this module wrote is lifted, so page-authored text
 *  that happens to contain the label is left whole. */
export function splitHostDetail(text: string): { headline: string; detail: string | null } {
  const byLength = [...recentDetails].sort((a, b) => b.length - a.length);
  for (const detail of byLength) {
    const span = t("host-error.with-detail", { primary: "", detail });
    const at = text.indexOf(span);
    if (at === -1) continue;
    const before = text.slice(0, at);
    let after = text.slice(at + span.length);
    // "{error}." around a sentence that already ends in a full stop.
    if (before.endsWith(".") && after.startsWith(".")) after = after.slice(1);
    return { headline: (before + after).trim(), detail };
  }
  return { headline: text, detail: null };
}

export class HostCommandError extends Error {
  readonly code: string | null;
  readonly operation: string;
  readonly detail: string;
  /** The plain sentence alone, for a surface that states its own recovery. */
  readonly problem: string;
  override toString(): string { return this.message; }
  constructor(command: string, value: unknown) {
    super(commandFailureMessage(value));
    const failure = failureOf(value);
    this.code = failure?.code ?? (value === "application locked" ? "application_locked" : null);
    this.operation = failure?.operation ?? command;
    this.detail = failureDetail(value);
    this.problem = failureProblem(value);
  }
}

export function isApplicationLocked(value: unknown): boolean {
  return value === "application locked" || failureOf(value)?.code === "application_locked"
    || (value instanceof HostCommandError && value.code === "application_locked");
}

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
export function localizedInvoke(invoke: Invoke): Invoke {
  return async (command, args) => {
    try { return await invoke(command, args); }
    catch (error) { throw new HostCommandError(command, error); }
  };
}
