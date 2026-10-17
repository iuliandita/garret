// Independent readers for stored manuscript JSON. No editor or store imports.
export interface TextRun {
  type: "text";
  text: string;
  marks?: { type: string }[];
}
export interface Paragraph {
  type: "paragraph";
  content?: TextRun[];
}
export interface LegacyDocument {
  type: "doc";
  content: Paragraph[];
}
type RecordValue = Record<string, unknown>;

function refuse(reason: string): never {
  throw new Error(`harness document refused: ${reason}`);
}
function record(value: unknown, allowed: string[]): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse("expected object");
  const result = value as RecordValue;
  for (const key of Object.keys(result)) if (!allowed.includes(key)) refuse(`unknown field ${key}`);
  return result;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) refuse("expected content array");
  return value;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    refuse("invalid ID");
  }
  return value;
}
function attribute(value: unknown): void {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 65536) refuse("invalid attribute text");
}

/** Validate the entire body before projecting anything, including excluded attributes. */
function parseDocument(body: string, assets: ReadonlySet<string>, legacyOnly: boolean): unknown {
  const root = record(JSON.parse(body), ["type", "content"]);
  if (root.type !== "doc") refuse("expected doc");
  const instances = new Set<string>();
  const instance = (value: unknown): void => {
    const key = id(value);
    if (instances.has(key)) refuse("duplicate instance ID");
    instances.add(key);
  };
  for (const raw of list(root.content)) {
    const block = record(raw, ["type", "content", "attrs"]);
    switch (block.type) {
      case "paragraph":
        record(raw, ["type", "content"]);
        for (const rawInline of block.content === undefined ? [] : list(block.content)) {
          const inline = record(rawInline, ["type", "text", "marks", "attrs"]);
          if (inline.type === "text") {
            record(rawInline, ["type", "text", "marks"]);
            if (typeof inline.text !== "string" || inline.text.length === 0) refuse("invalid text");
            const marks = new Set<string>();
            for (const rawMark of inline.marks === undefined ? [] : list(inline.marks)) {
              const mark = record(rawMark, ["type"]);
              if (typeof mark.type !== "string" || !["em", "strong", "underline"].includes(mark.type)) refuse("unknown mark");
              if (marks.has(mark.type)) refuse("duplicate mark");
              marks.add(mark.type);
            }
          } else if (inline.type === "endnote") {
            if (legacyOnly) refuse("this rig supports only paragraph/text documents");
            record(rawInline, ["type", "attrs"]);
            const attrs = record(inline.attrs, ["id", "fmt", "body"]);
            instance(attrs.id);
            if (attrs.fmt !== "text") refuse("unsupported note fmt");
            attribute(attrs.body);
          } else refuse("unknown inline node");
        }
        break;
      case "figure": {
        if (legacyOnly) refuse("this rig supports only paragraph/text documents");
        record(raw, ["type", "attrs"]);
        const attrs = record(block.attrs, ["id", "asset_id", "width", "caption", "alt"]);
        instance(attrs.id);
        if (!assets.has(id(attrs.asset_id))) refuse("unregistered figure asset");
        if (typeof attrs.width !== "string" || !["full", "half", "page"].includes(attrs.width)) refuse("invalid figure width");
        attribute(attrs.caption);
        attribute(attrs.alt);
        break;
      }
      case "scene_break":
        if (legacyOnly) refuse("this rig supports only paragraph/text documents");
        record(raw, ["type"]);
        break;
      default: refuse("unknown block node");
    }
  }
  return root;
}

export function readDocument(body: string, assets: ReadonlySet<string> = new Set()): unknown {
  return parseDocument(body, assets, false);
}

/** These rigs grade paragraph-only formats; refusing atoms avoids certifying omitted fields. */
export function readLegacyDocument(body: string): LegacyDocument {
  return parseDocument(body, new Set(), true) as LegacyDocument;
}

/** Inline references contribute neither text nor separators. Every block boundary separates prose. */
export function proseText(body: string, assets: ReadonlySet<string> = new Set()): string {
  const root = readDocument(body, assets) as { content: { type: string; content?: { type: string; text?: string }[] }[] };
  return root.content.map((block) => block.type === "paragraph"
    ? (block.content ?? []).filter((node) => node.type === "text").map((node) => node.text).join("")
    : "").join(" ");
}
export function legacyText(body: string): string {
  readLegacyDocument(body);
  return proseText(body);
}

export function legacySearchText(body: string): string | null {
  let root: unknown;
  try { root = JSON.parse(body) as unknown; } catch { return null; }
  if (root === null || typeof root !== "object" || !("type" in root) || root.type !== "doc") return null;
  return legacyText(body);
}
export function proseWords(body: string, assets: ReadonlySet<string> = new Set()): number {
  return proseText(body, assets).split(/\p{White_Space}+/u).filter((word) => word.length > 0).length;
}
export function legacyMarkedRuns(body: string, mark?: string): string[] {
  return readLegacyDocument(body).content.flatMap((block) => (block.content ?? [])
    .filter((node) => mark === undefined ? (node.marks?.length ?? 0) > 0 : node.marks?.some((m) => m.type === mark))
    .map((node) => node.text));
}

/** FNV-1a over UTF-16 code units, independently evaluated with unsigned bigint arithmetic. */
export function legacyBodyHash(body: string): string {
  readLegacyDocument(body);
  let hash = 2166136261n;
  for (let index = 0; index < body.length; index++) {
    hash = ((hash ^ BigInt(body.charCodeAt(index))) * 16777619n) & 0xffffffffn;
  }
  return hash.toString(16).padStart(8, "0");
}
