import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  MULTILINE_FIELDS,
  PRIVATE_FIELDS,
  PUBLIC_FIELDS,
  PUBLISHING_FIELDS,
  blankIdentity,
  checkName,
  checkStateName,
  crossIdentityClaim,
  fieldLabel,
  fieldPlace,
  fieldRow,
  findingSentence,
  formatName,
  identityLabel,
  linksFromText,
  linksToText,
  pinnedLine,
  severityName,
  surfaceName,
  type IdentitiesView,
  type Preflight,
  type PreflightFinding,
} from "../src/identity";
import { EN } from "../src/i18n";

const HOST = join(import.meta.dir, "..", "..", "shell-tauri", "src-tauri", "src", "identity.rs");

async function host(): Promise<string> {
  return await Bun.file(HOST).text();
}

/** A report with nothing wrong, which every fixture below moves one thing off. */
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

function finding(over: Partial<PreflightFinding> = {}): PreflightFinding {
  return {
    kind: "cross_identity",
    severity: "blocker",
    surface: "document_body",
    item_id: "s2",
    offset: 9,
    matched: "Bram Kell",
    ...over,
  };
}

describe("the three tiers", () => {
  test("the page restates the host's fields and a test says when they part", async () => {
    // `covers.ts`' rule and `item-types.ts`' before it: the page holds its own
    // copy of a small closed set the host owns, and what stops the two drifting
    // is a test that reads the host. A field added on one side only fails here
    // rather than shipping a form that cannot edit it.
    const source = await host();
    const fieldsOf = (struct: string): string[] => {
      const at = source.indexOf(`pub struct ${struct} {`);
      expect(at).toBeGreaterThan(-1);
      const end = source.indexOf("\n}", at);
      return [...source.slice(at, end).matchAll(/pub ([a-z_]+):/g)].map((m) => m[1] as string);
    };
    const declaredPublic = fieldsOf("Public");
    const declaredPublishing = fieldsOf("Publishing");
    const declaredPrivate = fieldsOf("Private");
    // Vacuity guards: a pattern that found nothing would pass every comparison
    // below against a page list it never read.
    expect(declaredPublic.length).toBe(4);
    expect(declaredPublishing.length).toBe(2);
    expect(declaredPrivate.length).toBe(3);
    expect([...PUBLIC_FIELDS] as string[]).toEqual(declaredPublic);
    expect([...PUBLISHING_FIELDS] as string[]).toEqual(declaredPublishing);
    expect([...PRIVATE_FIELDS] as string[]).toEqual(declaredPrivate);
  });

  test("the pin the host declares has no private tier and no field this page cannot show", async () => {
    // THE GUARANTEE, ASSERTED FROM THE PAGE'S SIDE. `Pin` is what travels inside
    // a project file, therefore into a backup, a mirror and salvage's
    // manifest.json. A `private` field appearing in it is the one change that
    // would break this feature's whole claim, and it must fail on both sides.
    const source = await host();
    const at = source.indexOf("pub struct Pin {");
    expect(at).toBeGreaterThan(-1);
    const declared = [
      ...source.slice(at, source.indexOf("\n}", at)).matchAll(/pub ([a-z_]+):/g),
    ].map((m) => m[1] as string);
    expect(declared.length).toBe(5);
    expect(declared).not.toContain("private");
    expect(declared.sort()).toEqual(["identity_id", "pinned_at", "public", "publishing", "rev"]);
  });

  test("every field has a label and the long ones are a subset of the fields", () => {
    for (const field of [...PUBLIC_FIELDS, ...PUBLISHING_FIELDS, ...PRIVATE_FIELDS]) {
      expect({ field, key: `identity.field.${field}` in EN }).toEqual({ field, key: true });
    }
    const all = [...PUBLIC_FIELDS, ...PUBLISHING_FIELDS, ...PRIVATE_FIELDS] as string[];
    for (const field of MULTILINE_FIELDS) {
      expect({ field, known: all.includes(field) }).toEqual({ field, known: true });
    }
  });

  test("a blank identity carries every tier and no id", () => {
    // The id is EMPTY because the HOST mints one: an id the page composed would
    // be an id the page could aim at an entry that already exists.
    const blank = blankIdentity();
    expect(blank.id).toBe("");
    expect(blank.rev).toBe(0);
    expect(blank.public.links).toEqual([]);
    expect(blank.private.legal_name).toBe("");
  });
});

describe("what a pen name is called", () => {
  test("a pen name with no name is not a blank row", () => {
    // A blank row is a pen name a writer cannot find again to give a name to.
    const named = { ...blankIdentity(), id: "i1" };
    named.public.name = "Ada Vane";
    expect(identityLabel(named)).toBe("Ada Vane");
    expect(identityLabel({ ...blankIdentity(), id: "i2" })).toBe(EN["identity.field.name"]);
    // Whitespace is not a name either.
    const spaces = { ...blankIdentity(), id: "i3" };
    spaces.public.name = "   ";
    expect(identityLabel(spaces)).toBe(EN["identity.field.name"]);
  });

  test("the line under the heading is painted for a book pinned to nothing too", () => {
    // A panel that said nothing when nothing was pinned would leave a writer
    // unable to tell "no pen name" from "this panel has not looked".
    const none: IdentitiesView = { identities: [], pinned: null, stale: false };
    expect(pinnedLine(none)).toBe(EN["identity.unpinned"]);
    const pinned: IdentitiesView = {
      identities: [],
      pinned: {
        identity_id: "i1",
        rev: 1,
        pinned_at: 10,
        public: { name: "Ada Vane", sort_name: "", bio: "", links: [] },
        publishing: { imprint: "", rights: "" },
      },
      stale: false,
    };
    expect(pinnedLine(pinned)).toContain("Ada Vane");
    // And the two sentences are different, or the line says nothing at all.
    expect(pinnedLine(pinned)).not.toBe(pinnedLine(none));
  });
});

describe("links", () => {
  test("a trailing newline is not a link", () => {
    expect(linksFromText("https://a.invalid\n\nhttps://b.invalid\n")).toEqual([
      "https://a.invalid",
      "https://b.invalid",
    ]);
    expect(linksFromText("")).toEqual([]);
    expect(linksToText(["https://a.invalid", "https://b.invalid"])).toBe(
      "https://a.invalid\nhttps://b.invalid",
    );
  });
});

describe("the report's words", () => {
  test("every machine word the host can emit has a catalog key", async () => {
    // THE GUARD THAT MAKES THE MAPPING HONEST. The host answers in machine words
    // and this page words them; a word added to `identity.rs` with no key here
    // paints the machine word at a writer. Read from the host rather than
    // restated, for `covers.test.ts`' reason.
    const source = await host();
    const constants = (pattern: RegExp): string[] =>
      [...source.matchAll(pattern)].map((m) => m[1] as string);
    const checks = constants(/pub const CHECK_[A-Z_]+: &str = "([a-z_]+)";/g);
    const states = constants(/pub const STATE_[A-Z_]+: &str = "([a-z_]+)";/g);
    const severities = constants(/pub const SEVERITY_[A-Z_]+: &str = "([a-z_]+)";/g);
    const kinds = constants(/pub const FINDING_[A-Z_]+: &str = "([a-z_]+)";/g);
    const listed = (name: string): string[] => {
      const body = source.match(new RegExp(`pub const ${name}: \\[&str; \\d+\\] = \\[([^\\]]*)\\]`));
      return [...(body?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);
    };
    const surfaces = [...listed("SURFACES_CHECKED"), ...listed("SURFACES_UNCHECKED")];
    // Vacuity guards on every list: a pattern that found nothing would pass the
    // loops below while reading nothing at all.
    expect(checks.length).toBe(6);
    expect(states.length).toBe(3);
    expect(severities.length).toBe(2);
    expect(kinds.length).toBe(4);
    expect(surfaces.length).toBe(17);
    for (const name of checks) {
      expect({ name, key: `preflight.check.${name}` in EN }).toEqual({ name, key: true });
    }
    for (const state of states) {
      expect({ state, key: `preflight.state.${state}` in EN }).toEqual({ state, key: true });
    }
    for (const severity of severities) {
      expect({ severity, key: `preflight.severity.${severity}` in EN }).toEqual({
        severity,
        key: true,
      });
    }
    for (const kind of kinds) {
      expect({ kind, key: `preflight.finding.${kind}` in EN }).toEqual({ kind, key: true });
    }
    for (const surface of surfaces) {
      expect({ surface, key: `preflight.surface.${surface}` in EN }).toEqual({
        surface,
        key: true,
      });
    }
  });

  test("every place the host's field table names has a catalog key", async () => {
    // The other half of the one-table rule, from the page's side: a row added to
    // `ExportFields` with nowhere for this page to say where it lands would be
    // painted as `dc:date` at a writer.
    const source = await host();
    const places = [...source.matchAll(/at: "([a-z:-]+)",/g)].map((m) => m[1] as string);
    expect(places.length).toBe(5);
    for (const place of places) {
      expect({ place, key: `preflight.at.${place}` in EN }).toEqual({ place, key: true });
    }
  });

  test("a word this build has never heard of renders as itself", () => {
    // `sideName`'s rule: a host one version ahead is exactly the case, and
    // showing `dc:date` is a true label where showing nothing is a row with no
    // name and a missing-key marker is worse than either.
    expect(checkName("cross_identity")).toBe(EN["preflight.check.cross_identity"]);
    expect(checkName("spelling")).toBe("spelling");
    expect(checkStateName("timed_out")).toBe("timed_out");
    expect(surfaceName("front_matter")).toBe("front_matter");
    expect(fieldPlace("dc:date")).toBe("dc:date");
    expect(fieldLabel("pseudonym")).toBe("pseudonym");
    expect(formatName("rtf")).toBe("rtf");
    // docx IS a format now; its name comes from the catalog.
    expect(formatName("docx")).toBe(EN["preflight.format.docx"]);
    expect(severityName("advice")).toBe("advice");
  });

  test("the three check states are three different words", () => {
    // "Nothing to check" and "does not apply" are different answers -- a format
    // with no required field has nothing to check, and a format no validator
    // exists for cannot be checked at all -- and a reader who cannot tell them
    // apart reads both as a pass.
    const words = ["ran", "vacuous", "not_applicable"].map(checkStateName);
    expect(new Set(words).size).toBe(3);
  });

  test("a disclosed field says which field, where it lands and what it holds", () => {
    const row = fieldRow({ field: "name", at: "dc:creator", value: "Ada Vane" });
    expect(row).toContain("Ada Vane");
    expect(row).toContain(EN["preflight.at.dc:creator"]);
    expect(row).toContain(EN["identity.field.name"]);
  });
});

describe("what a finding says", () => {
  test("it names what was found and where it is", () => {
    const sentence = findingSentence(finding());
    expect(sentence).toContain("Bram Kell");
    expect(sentence).toContain(EN["preflight.surface.document_body"]);
    expect(sentence).toContain("s2");
    expect(sentence).toContain("9");
  });

  test("a finding with no location carries no empty parenthesis", () => {
    // A finding about the book's own name has no item and no offset, and
    // `(item , at )` reads as a value that failed to arrive.
    const sentence = findingSentence(
      finding({ surface: "project_name", item_id: null, offset: null }),
    );
    expect(sentence).toContain("Bram Kell");
    expect(sentence).not.toContain("(");
  });

  test("an offset of zero is still a location", () => {
    // `0` is falsy. A guard written as `finding.offset ? ... : ""` would drop
    // the location for a match at the very start of a scene, which is where a
    // dedication puts one.
    const sentence = findingSentence(finding({ offset: 0 }));
    expect(sentence).toContain("0");
    expect(sentence).toContain("s2");
  });

  test("a finding kind this build has never heard of renders as its kind", () => {
    expect(findingSentence(finding({ kind: "font_missing" }))).toBe("font_missing");
  });

  test("no sentence in this feature says the word leak", () => {
    // THE LANGUAGE IS PART OF THE FEATURE. The cross-identity check proves a
    // literal occurrence of a known other-identity name, with a location, and
    // nothing else -- an initialism, a misspelling, a name the vault has never
    // seen and an allusion are all invisible to it. A check that overstates what
    // it proves is worse than no check, because a writer acts on it.
    const suspects = ["leak", "leaks", "safe", "secure", "encrypted", "guarantee"];
    const sentences = Object.entries(EN)
      .filter(([key]) => key.startsWith("preflight.") || key.startsWith("identity."))
      .map(([, value]) => value);
    // Vacuity guard: an empty list would pass every check below.
    expect(sentences.length).toBeGreaterThan(40);
    for (const sentence of sentences) {
      for (const suspect of suspects) {
        const hit = new RegExp(`\\b${suspect}\\b`, "i").test(sentence);
        // "not encrypted" is the ONE permitted use, and it is the sentence that
        // says the private tier is protected against travelling rather than
        // against somebody at this machine.
        const allowed = suspect === "encrypted" && /not encrypted/i.test(sentence);
        expect({ suspect, sentence, hit: hit && !allowed }).toEqual({
          suspect,
          sentence,
          hit: false,
        });
      }
    }
  });
});

describe("what the report claims it compared", () => {
  test("with another pen name to compare against, it claims an occurrence and no more", () => {
    const ran = report({
      checks: report().checks.map((c) =>
        c.name === "cross_identity" ? { ...c, state: "ran" } : c,
      ),
    });
    expect(crossIdentityClaim(ran)).toBe(EN["preflight.surfaces.claim"]);
    expect(crossIdentityClaim(ran)).toContain("occurrence");
  });

  test("with nothing to compare against, it says so and does not claim a pass", () => {
    // "I had nothing to compare against" and "there is nothing to find" are
    // different answers, and this is the difference.
    expect(crossIdentityClaim(report())).toBe(EN["preflight.surfaces.nothing"]);
    expect(crossIdentityClaim(report())).not.toBe(EN["preflight.surfaces.claim"]);
  });

  test("a check list with no cross-identity row at all claims nothing", () => {
    // A host one version ahead that renamed or dropped the check must not make
    // this page claim the strongest sentence it has by default.
    const missing = report({ checks: report().checks.filter((c) => c.name !== "cross_identity") });
    expect(crossIdentityClaim(missing)).toBe(EN["preflight.surfaces.nothing"]);
  });
});
