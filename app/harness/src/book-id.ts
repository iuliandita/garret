import { Database } from "bun:sqlite";

/** Read the seeded file, independently of the application's routing code. */
export function readBookId(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query("SELECT value FROM meta WHERE key = 'book_id'").get() as { value: string } | null;
    if (row === null || !/^[0-9a-f]{32}$/.test(row.value)) {
      throw new Error("the seeded book has no valid identity");
    }
    return row.value;
  } finally {
    db.close();
  }
}
