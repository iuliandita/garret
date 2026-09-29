// lab/bakeoff/editor-core/src/model.ts
// Shared types for the editor core. No runtime deps so both the page bundle
// and the node harness can import them.

export type Script = "latin" | "cjk" | "rtl";

export interface SceneRef {
  id: string;
  title: string;
  order: number;
  parentId: string | null;
}

export interface Block {
  type: "paragraph" | "heading";
  script: Script;
  text: string;
}

export interface SceneDoc {
  id: string;
  blocks: Block[];
}

// One synthetic user action in the seeded workload script.
export type ActionKind = "type" | "quick-open" | "view-switch";

export interface Action {
  seq: number;
  kind: ActionKind;
  char?: string; // for "type"
  targetId?: string; // for "quick-open" / "view-switch": scene id
}

export type Workload =
  | "typing"
  | "navigation"
  | "cold-startup"
  | "warm-startup"
  | "soak";

// Materialized fixture the page fetches (refs for the navigator, docs for
// mounting). Produced by loader.materializeFixture from fixtures/out/<preset>.
export interface FixtureData {
  fixture: string;
  refs: SceneRef[];
  docs: SceneDoc[];
  // lazy-docs variant: `docs` ships empty and each scene is fetched on demand
  // from ./docs/<index>.json. The whole manuscript is then never resident.
  lazy?: boolean;
}
