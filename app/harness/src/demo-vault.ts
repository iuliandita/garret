// app/harness/src/demo-vault.ts
// Extracted out of shot-cli.ts because TWO rigs need the same
// two-identity vault for two different reasons: shot-cli.ts plants it to
// PHOTOGRAPH the pen-name strip and the library filtering it drives, and
// preflight-cli.ts plants the identical vault to run the cross-identity scan
// HEADLESSLY and grade what it finds. One shared literal, not two -- a second
// copy of this vault in either rig is how a cross-identity fixture drifts
// from the pin it is graded against.
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** The two pen names planted by `plantDemoIdentities` and read back by
 *  `pinBook`, so a second and third book can be pinned to either
 *  without a second vault literal drifting from the first. */
export const DEMO_VAULT = {
  version: 1,
  identities: [
    {
      id: "i1",
      rev: 1,
      aliases: ["Anne Grey", "A. Vane"],
      public: {
        name: "Ada Vane",
        sort_name: "Vane, Ada",
        bio: "Writes about harbours and the people who leave them.",
        links: ["https://example.invalid/ada"],
      },
      publishing: { imprint: "Vane Press", rights: "(c) Ada Vane" },
      private: {
        legal_name: "Margaret Hollis",
        contact: "margaret@example.invalid",
        admin: "Registered 2019.",
      },
    },
    {
      id: "i2",
      rev: 1,
      aliases: ["B. Kell"],
      public: { name: "Bram Kell", sort_name: "Kell, Bram", bio: "", links: [] },
      publishing: { imprint: "", rights: "" },
      private: { legal_name: "", contact: "", admin: "" },
    },
  ],
} as const;

/** A vault of two pen names beside `settings.json`, and the open book pinned to
 *  the first.
 *
 *  TWO AND NOT ONE, deliberately: with a single identity the cross-identity
 *  check has nothing to compare against and reports `not_applicable`, which is
 *  the LEAST interesting picture the report can produce. Two is the state the
 *  whole feature exists for.
 *
 *  THE PRIVATE TIER IS POPULATED, and that is the point of the capture: a
 *  reader looking at the picture can see a legal name on the panel and can then
 *  look at the exported file and at `manifest.json` and not find it.
 *
 *  Written as JSON and as a `meta` row rather than driven through the panel,
 *  the way --covers plants its two rows: a capture that had to drive nine
 *  fields to reach the state it is photographing would be photographing the
 *  typing.
 */
export function plantDemoIdentities(dataHomeDir: string, path: string, stale = false): void {
  const vault = stale ? {
    ...DEMO_VAULT,
    identities: [{ ...DEMO_VAULT.identities[0], rev: 2, public: {
      ...DEMO_VAULT.identities[0].public,
      bio: "Now writes about new shores and old promises.",
    } }, DEMO_VAULT.identities[1]],
  } : DEMO_VAULT;
  writeFileSync(join(dataHomeDir, "cc.local.app", "identities.json"), JSON.stringify(vault));
  // THE PIN IS THE PUBLIC AND PUBLISHING TIERS ONLY, which is what the host's
  // `identity::pin_of` builds -- restated here rather than imported, the same
  // rule every rig follows for a stored value: a rig that read the
  // application's own spelling could not tell a build that had changed it from
  // one that had not. A private field appearing in this literal would be this
  // rig lying about the guarantee.
  const pin = {
    identity_id: "i1",
    rev: 1,
    pinned_at: 1756400000,
    public: DEMO_VAULT.identities[0]?.public,
    publishing: DEMO_VAULT.identities[0]?.publishing,
  };
  const db = new Database(path);
  try {
    db.query(
      "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run("identity.pin", JSON.stringify(pin));
  } finally {
    db.close();
  }
}

/** Pin `path`'s book to one of `DEMO_VAULT`'s two identities (100, `--library`).
 *  THE PIN IS THE PUBLIC AND PUBLISHING TIERS ONLY, `plantDemoIdentities`'s own
 *  reason: that is what the host's `identity::pin_of` builds, restated here
 *  rather than imported. Assumes `plantDemoIdentities` has already written
 *  the vault this identity id lives in. */
export function pinBook(path: string, identityId: (typeof DEMO_VAULT.identities)[number]["id"]): void {
  const identity = DEMO_VAULT.identities.find((i) => i.id === identityId);
  if (identity === undefined) throw new Error(`pinBook: no identity ${identityId} in DEMO_VAULT`);
  const pin = {
    identity_id: identity.id,
    rev: 1,
    pinned_at: 1756400000,
    public: identity.public,
    publishing: identity.publishing,
  };
  const db = new Database(path);
  try {
    db.query(
      "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run("identity.pin", JSON.stringify(pin));
  } finally {
    db.close();
  }
}
