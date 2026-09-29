// app/ui/src/identity.ts
// Pen names, and what an export can honestly say it checked, as the page sees
// them.
//
// THIS MODULE HOLDS NO RULE AND NO VERDICT, which is `covers.ts`' rule met
// again and for its reason. Which fields a format writes, which surfaces were
// read, what blocks and what warns, and whether a pin is stale are all decided
// by the host and arrive with the answer. What is here is the mapping from the
// host's machine words to catalog keys, and nothing else -- a pure function, so
// it can be tested and mutated, which is what `main.ts`'s zero coverage taught.
//
// THE LANGUAGE IS PART OF THE FEATURE. The cross-identity check proves a
// LITERAL OCCURRENCE of a known other-identity name, with a location, and
// nothing else. Every sentence this module reaches for says that and never "no
// leaks were found": a check that overstates what it proves is worse than no
// check, because a writer acts on it.

import { messages, t } from "./i18n";

/** The three tiers, and which fields are in each.
 *
 *  RESTATED FROM THE HOST, exactly as `item-types.ts` restates the item types
 *  and `covers.ts` the two sides -- and `identity.test.ts` parses
 *  `identity.rs`, so a field added on one side only breaks a test. A shared
 *  constant would hide a drift; a parsed one fails on it.
 *
 *  THE PRIVATE TIER IS HERE AND IS NOT IN THE PIN, and that asymmetry is the
 *  whole feature: a writer types a legal name into this panel, and the copy a
 *  book keeps has no field to put it in. */
export const PUBLIC_FIELDS = ["name", "sort_name", "bio", "links"] as const;
export const PUBLISHING_FIELDS = ["imprint", "rights"] as const;
export const PRIVATE_FIELDS = ["legal_name", "contact", "admin"] as const;

/** Which fields are long enough to want more than one line. */
export const MULTILINE_FIELDS = ["bio", "links", "contact", "admin"] as const;

export interface IdentityPublic {
  name: string;
  sort_name: string;
  bio: string;
  links: string[];
}

export interface IdentityPublishing {
  imprint: string;
  rights: string;
}

export interface IdentityPrivate {
  legal_name: string;
  contact: string;
  admin: string;
}

export interface Identity {
  id: string;
  rev: number;
  aliases: string[];
  public: IdentityPublic;
  publishing: IdentityPublishing;
  private: IdentityPrivate;
}

/** The copy a book keeps. IT HAS NO `private`, and that is not an omission in
 *  this interface: the host's `Pin` has no such field, so there is nothing for
 *  a wider type here to receive. */
export interface IdentityPin {
  identity_id: string;
  rev: number;
  pinned_at: number;
  public: IdentityPublic;
  publishing: IdentityPublishing;
}

export interface PinPreview {
  token: string;
  before: IdentityPin | null;
  before_unreadable: boolean;
  after: IdentityPin;
}

export interface IdentitiesView {
  identities: Identity[];
  pinned: IdentityPin | null;
  stale: boolean;
}

export interface PreflightCheck {
  name: string;
  state: string;
}

export interface PreflightFinding {
  kind: string;
  severity: string;
  surface: string;
  item_id: string | null;
  offset: number | null;
  matched: string;
}

export interface PreflightField {
  field: string;
  at: string;
  value: string;
}

export interface PreflightIdentity {
  identity_id: string;
  name: string;
  rev: number;
  stale: boolean;
}

export interface WarningReason {
  check: string;
  format: string;
  surface: string;
  item_id: string | null;
  offset: number | null;
  fingerprint: string;
  reason: string;
  at_ms: number;
}

export type ReasonHistory =
  | { state: "available"; entries: WarningReason[] }
  | { state: "unavailable" };

export interface Preflight {
  format: string;
  identity: PreflightIdentity | null;
  fields: PreflightField[];
  checks: PreflightCheck[];
  skipped: string[];
  findings: PreflightFinding[];
  surfaces_checked: string[];
  surfaces_unchecked: string[];
  blockers: number;
  warning_tokens: { finding_index: number; token: string }[];
  reason_history: ReasonHistory;
}

/** An empty identity, for the New control. The id is empty: the HOST mints one,
 *  because an id the page composed would be an id the page could aim at an
 *  existing entry. */
export function blankIdentity(): Identity {
  return {
    id: "",
    rev: 0,
    aliases: [],
    public: { name: "", sort_name: "", bio: "", links: [] },
    publishing: { imprint: "", rights: "" },
    private: { legal_name: "", contact: "", admin: "" },
  };
}

/** A catalog word for a machine word, falling back to the machine word itself.
 *
 *  A HOST ONE VERSION AHEAD IS EXACTLY THE CASE this exists for, `sideName`'s
 *  rule: showing `dc:date` is a true label where showing nothing is a row with
 *  no name, and painting a missing-key marker is worse than either. */
function word(prefix: string, id: string): string {
  const key = `${prefix}${id}`;
  return messages.has(key) ? t(key) : id;
}

/** What a pen name is called in the list. A name nobody has typed yet is not a
 *  blank row: it is a pen name with no name, and saying so is the only way a
 *  writer can find it again and give it one. */
export function identityLabel(identity: Identity): string {
  const name = identity.public.name.trim();
  return name === "" ? t("identity.field.name") : name;
}

/** The line under the heading: what this book is written as.
 *
 *  PAINTED FOR EVERY BOOK, `coverPageLine`'s rule. A panel that said nothing
 *  when nothing was pinned would leave a writer unable to tell "no pen name"
 *  from "this panel has not looked". */
export function pinnedLine(view: IdentitiesView): string {
  if (view.pinned === null) return t("identity.unpinned");
  const name = view.pinned.public.name.trim();
  return t("identity.pinned", {
    name: name === "" ? t("identity.field.name") : name,
  });
}

/** A field's label. */
export function fieldLabel(field: string): string {
  return word("identity.field.", field);
}

/** The links a writer typed, one per line, as the host's list. Blank lines are
 *  dropped: a trailing newline is not a link. */
export function linksFromText(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** The host's list, as text a writer edits. */
export function linksToText(links: string[]): string {
  return links.join("\n");
}

// --------------------------------------------------------- the export report

/** The format's name, for the report's heading. */
export function formatName(format: string): string {
  return word("preflight.format.", format);
}

/** A check's name. */
export function warningKindName(kind: string): string {
  return word("preflight.history.kind.", kind);
}

export function checkName(name: string): string {
  return word("preflight.check.", name);
}

/** What a check did: checked, nothing to check, or does not apply.
 *
 *  THREE WORDS AND NOT TWO. "Nothing to check" and "does not apply" are
 *  different answers -- a format with no required field has nothing to check,
 *  and a format no validator exists for is one this build cannot check at all --
 *  and a reader who cannot tell them apart reads both as a pass. */
export function checkStateName(state: string): string {
  return word("preflight.state.", state);
}

/** A surface's name. */
export function surfaceName(surface: string): string {
  return word("preflight.surface.", surface);
}

/** Where a disclosed field lands in the file. */
export function fieldPlace(at: string): string {
  return word("preflight.at.", at);
}

/** One row of "what this format will write". */
export function fieldRow(field: PreflightField): string {
  return t("preflight.field.row", {
    field: fieldLabel(field.field),
    at: fieldPlace(field.at),
    value: field.value,
  });
}

/** A finding's severity, as a word. */
export function severityName(severity: string): string {
  return word("preflight.severity.", severity);
}

/** What one finding says.
 *
 *  THE SENTENCE NAMES WHAT WAS FOUND AND WHERE, AND CLAIMS NOTHING ELSE. A
 *  cross-identity finding is an OCCURRENCE OF A NAME with a location; it is
 *  never described as a leak, because the check cannot see one. The location is
 *  appended only when there is one -- a finding about the book's own name has no
 *  item and no offset, and an empty parenthesis would read as a missing value. */
export function findingSentence(finding: PreflightFinding): string {
  const key = `preflight.finding.${finding.kind}`;
  if (!messages.has(key)) return finding.kind;
  const where =
    finding.item_id === null || finding.offset === null
      ? ""
      : t("preflight.finding.at", {
          item: finding.item_id,
          offset: String(finding.offset),
        });
  return t(key, {
    matched: finding.matched,
    surface: surfaceName(finding.surface),
    where,
  });
}

/** What the report says it compared, and what it did not.
 *
 *  THE ONE SENTENCE THE DESIGN FIXES. With another pen name to compare against,
 *  it says no OCCURRENCE OF A KNOWN OTHER-IDENTITY NAME was found in the
 *  surfaces listed -- never "no leaks". With nothing to compare against, it says
 *  so, because "I had nothing to compare against" and "there is nothing to find"
 *  are different answers and this is the difference. */
export function crossIdentityClaim(report: Preflight): string {
  const state = report.checks.find((c) => c.name === "cross_identity");
  if (state === undefined || state.state !== "ran") {
    return t("preflight.surfaces.nothing");
  }
  return t("preflight.surfaces.claim");
}
