import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const AUTHORS = {
  "pride-and-prejudice": { name: "Jane Austen", sortName: "Austen, Jane", source: "1342" },
  alice: { name: "Lewis Carroll", sortName: "Carroll, Lewis", source: "11" },
  dracula: { name: "Bram Stoker", sortName: "Stoker, Bram", source: "345" },
} as const;

export const CLASSIC_VAULT = {
  version: 1,
  identities: Object.entries(AUTHORS).map(([fixture, author]) => ({
    id: `classic-${fixture}`,
    rev: 1,
    aliases: [],
    public: {
      name: author.name,
      sort_name: author.sortName,
      bio: "",
      links: [`https://www.gutenberg.org/ebooks/${author.source}`],
    },
    publishing: { imprint: "", rights: "Original text: public domain in the USA." },
    private: { legal_name: "", contact: "", admin: "" },
  })),
};

export function pinClassicBook(path: string, fixture: string): void {
  const identity = CLASSIC_VAULT.identities.find((entry) => entry.id === `classic-${fixture}`);
  if (identity === undefined) throw new Error(`No classic author for ${fixture}`);
  const pin = {
    identity_id: identity.id,
    rev: identity.rev,
    pinned_at: 0,
    public: identity.public,
    publishing: identity.publishing,
  };
  const db = new Database(path);
  try {
    db.query("INSERT INTO meta(key,value) VALUES('identity.pin',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify(pin));
  } finally {
    db.close();
  }
}

export function writeClassicVault(dataHome: string, staleFixture?: string): void {
  const dir = join(dataHome, "garret");
  mkdirSync(dir, { recursive: true });
  const vault = staleFixture === undefined ? CLASSIC_VAULT : {
    ...CLASSIC_VAULT,
    identities: [...CLASSIC_VAULT.identities].sort((a, b) =>
      Number(b.id === `classic-${staleFixture}`) - Number(a.id === `classic-${staleFixture}`))
      .map((identity) => identity.id === `classic-${staleFixture}`
      ? { ...identity, rev: 2, public: { ...identity.public, bio: "Author of this public-domain excerpt." } }
      : identity),
  };
  writeFileSync(join(dir, "identities.json"), JSON.stringify(vault, null, 2));
}

if (import.meta.main) {
  const out = process.argv[2];
  if (out === undefined || process.argv.length !== 3) throw new Error("Expected a sample book directory");
  for (const fixture of Object.keys(AUTHORS)) pinClassicBook(join(out, `${fixture}.db`), fixture);
}
