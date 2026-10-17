export const MAX_ATTRIBUTE_BYTES = 64 * 1024;

export function refusedDocumentId(message: string): string | null {
  return /document format refused: ([^:\n;]+): /.exec(message)?.[1] ?? null;
}

type ObjectValue = Record<string, unknown>;

function object(value: unknown, keys: readonly string[]): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) throw new Error("invalid document object");
  return value as ObjectValue;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("invalid document content");
  return value;
}

function uuid(value: unknown): string {
  if (typeof value !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error("invalid instance or asset ID");
  }
  return value;
}

function boundedText(value: unknown): void {
  if (typeof value !== "string" || new TextEncoder().encode(value).length > MAX_ATTRIBUTE_BYTES) {
    throw new Error("invalid attribute text");
  }
}

export function validDocument(value: unknown, allowNew = false, assets: ReadonlySet<string> | null = new Set()): boolean {
  try {
    const root = object(value, ["type", "content"]);
    if (root.type !== "doc") return false;
    const blocks = array(root.content);
    const ids = new Set<string>();
    const instance = (value: unknown): void => {
      const id = uuid(value);
      if (ids.has(id)) throw new Error("duplicate instance ID");
      ids.add(id);
    };
    for (const raw of blocks) {
      const block = object(raw, ["type", "content", "attrs"]);
      if (block.type === "paragraph") {
        object(raw, ["type", "content"]);
        if (block.content === undefined) continue;
        for (const child of array(block.content)) {
          const node = object(child, ["type", "text", "marks", "attrs"]);
          if (node.type === "text") {
            object(child, ["type", "text", "marks"]);
            if (typeof node.text !== "string" || node.text.length === 0) return false;
            if (node.marks !== undefined) {
              const seen = new Set<unknown>();
              for (const rawMark of array(node.marks)) {
                const mark = object(rawMark, ["type"]);
                if (typeof mark.type !== "string" || !["em", "strong", "underline"].includes(mark.type) || seen.has(mark.type)) return false;
                seen.add(mark.type);
              }
            }
          } else if (node.type === "endnote" && allowNew) {
            object(child, ["type", "attrs"]);
            const attrs = object(node.attrs, ["id", "fmt", "body"]);
            instance(attrs.id);
            if (attrs.fmt !== "text") return false;
            boundedText(attrs.body);
          } else return false;
        }
      } else if (block.type === "figure" && allowNew) {
        object(raw, ["type", "attrs"]);
        const attrs = object(block.attrs, ["id", "asset_id", "width", "caption", "alt"]);
        instance(attrs.id);
        const assetId = uuid(attrs.asset_id);
        if ((assets !== null && !assets.has(assetId)) || typeof attrs.width !== "string" || !["full", "half", "page"].includes(attrs.width)) return false;
        boundedText(attrs.caption);
        boundedText(attrs.alt);
      } else if (block.type === "scene_break" && allowNew) {
        object(raw, ["type"]);
      } else return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Structural readers cannot resolve originals; the host validates asset ownership. */
export function validDocumentShape(value: unknown): boolean {
  return validDocument(value, true, null);
}
