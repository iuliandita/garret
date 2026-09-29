// lab/fixtures/gen/src/model.ts
export interface FixtureSpec {
  name: string;
  seed: string;
  totalWords: number;
  structuralItems: number;   // parts + chapters + scenes + freeform docs
  records: number;           // knowledge + research entries
  assetBytes: number;        // total noise asset volume
  assetCount: number;
  // Allocate asset noise sparsely: apparent size, near-zero blocks on disk.
  // Neither track reads asset bytes, so this is a disk-cost concession, not a
  // change to what is measured. Recorded in the fixture manifest either way.
  sparseAssets?: boolean;
}

export interface Item {
  id: string;                // stable identifier, e.g. "it-000123"
  type: "part" | "chapter" | "scene" | "doc";
  title: string;
  parentId: string | null;
  order: number;
  sceneWordTarget?: number;  // scenes only
}

export interface Block {
  type: "paragraph" | "heading";
  script: "latin" | "cjk" | "rtl";
  text: string;
}

export interface Scene {
  id: string;                // matches Item.id
  blocks: Block[];
}

export interface KnowledgeRecord {
  id: string;                // "kr-000042"
  kind: "person" | "place" | "object" | "custom" | "research";
  name: string;
  aliases: string[];
  note: string;
  linkedItemIds: string[];
}
