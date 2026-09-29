import { Database } from "bun:sqlite";

const MAX_DEPTH = 64;

const BOOT_SCENE_SQL = `WITH RECURSIVE walk(id, parent_id, type, position, depth, path) AS (
  SELECT id, parent_id, type, position, 0, position
    FROM item WHERE parent_id IS NULL
  UNION ALL
  SELECT i.id, i.parent_id, i.type, i.position, w.depth + 1, w.path || '/' || i.position
    FROM item i JOIN walk w ON i.parent_id = w.id
   WHERE w.depth + 1 < ${MAX_DEPTH}
)
SELECT id FROM walk WHERE type = 'scene' ORDER BY path LIMIT 1`;

export interface PrefsInputEvidence {
  scene_id: string;
  attempts: number;
  expected_bytes: number;
  actual_bytes: number;
}

export interface PrefsInputPoll {
  timeoutMs: number;
  pollMs: number;
}

interface StoredText {
  text: string;
}

/** The initial document is the first scene in the same depth-first order the
 * page uses at boot. Its persisted ProseMirror body is read independently of
 * the live accessibility box, so a stable box cannot stand in for lost input. */
export function readBootSceneText(projectPath: string): { sceneId: string; text: string } {
  const db = new Database(projectPath, { readonly: true });
  try {
    const scene = db.query(BOOT_SCENE_SQL).get() as { id: string } | null;
    if (scene === null) throw new Error("seeded project has no boot scene");
    const doc = db.query("SELECT body FROM doc WHERE item_id = ?1").get(scene.id) as
      | { body: string }
      | null;
    if (doc === null) throw new Error(`boot scene ${scene.id} has no persisted body`);
    return { sceneId: scene.id, text: parseStoredText(doc.body).text };
  } finally {
    db.close();
  }
}

/** Wait for the exact bytes typed into the boot scene. A malformed document,
 * a missing row, a truncated write, or text committed to another scene never
 * satisfies this check. */
export async function waitForExactBootSceneText(
  projectPath: string,
  expected: string,
  { timeoutMs, pollMs }: PrefsInputPoll,
): Promise<PrefsInputEvidence> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let last = "no readable boot scene";
  while (true) {
    attempts += 1;
    try {
      const actual = readBootSceneText(projectPath);
      if (actual.text === expected) {
        return {
          scene_id: actual.sceneId,
          attempts,
          expected_bytes: Buffer.byteLength(expected),
          actual_bytes: Buffer.byteLength(actual.text),
        };
      }
      last = `boot scene ${actual.sceneId} holds ${JSON.stringify(actual.text)}`;
    } catch (error: unknown) {
      last = String(error);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `typed passage did not commit to the boot scene within ${timeoutMs} ms; ${last}`,
      );
    }
    await Bun.sleep(pollMs);
  }
}

function parseStoredText(body: string): StoredText {
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    throw new Error("boot scene body is not valid JSON");
  }
  if (!isRecord(document) || document.type !== "doc" || !Array.isArray(document.content)) {
    throw new Error("boot scene body is not a ProseMirror document");
  }

  if (document.content.length !== 1) {
    throw new Error("typed passage must occupy exactly one paragraph");
  }
  const paragraph = document.content[0];
  if (!isRecord(paragraph) || paragraph.type !== "paragraph" || !Array.isArray(paragraph.content)) {
    throw new Error("typed passage must be a paragraph of plain text");
  }
  let text = "";
  for (const node of paragraph.content) {
    if (!isRecord(node) || node.type !== "text" || typeof node.text !== "string") {
      throw new Error("typed passage contains a non-text node");
    }
    if (node.marks !== undefined && (!Array.isArray(node.marks) || node.marks.length !== 0)) {
      throw new Error("typed passage contains formatting marks");
    }
    text += node.text;
  }
  return { text };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
