import { Fragment, Slice, type Node as PmNode } from "prosemirror-model";
import { validDocumentShape } from "./document-format";

function imagePayload(text: string): boolean {
  const value = text.trim();
  if (/^data:(?:image\/[^,\s]*,|[^,;\s]+;base64,)/i.test(value)) return true;
  if (value.length >= 256 && /^[A-Za-z0-9+/\r\n]+={0,2}$/.test(value)) return true;
  if (!value.startsWith("<") || !/<(?:svg|img|picture)\b/i.test(value)) return false;
  return value.replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, "").replace(/&nbsp;|&#160;/gi, "").trim() === "";
}

export function refusesPicture(data: DataTransfer | null): boolean {
  if (!data) return false;
  const plain = data.getData("text/plain");
  const html = data.getData("text/html");
  // Only whole image markup, data URIs, or long base64-alphabet tokens (optional
  // line wrapping) qualify; spaces/punctuation in prose keep its normal path.
  if (imagePayload(plain) || imagePayload(html)) return true;
  const hasProse = plain.trim() !== "" || html.replace(/<[^>]*>/g, "").trim() !== "";
  return !hasProse && (Array.from(data.types).some(type => /^image\//i.test(type) || type === "Files") || data.files.length > 0);
}

export function validateClipboardHtml(html: string): void {
  if (!html.includes("data-garret-")) return;
  const root = document.createElement("div");
  root.innerHTML = html;
  const ids = new Set<string>();
  for (const element of root.querySelectorAll("[data-garret-endnote],[data-garret-figure]")) {
    const type = element.hasAttribute("data-garret-endnote") ? "endnote" : "figure";
    if (element.tagName !== (type === "endnote" ? "SUP" : "FIGURE")) throw new Error("unsupported clipboard atom");
    const attrs = JSON.parse(element.getAttribute("data-garret-" + type) ?? "null") as Record<string, unknown>;
    const node = { type, attrs };
    const content = type === "endnote" ? [{ type: "paragraph", content: [node] }] : [node];
    if (!validDocumentShape({ type: "doc", content }) || ids.has(attrs.id as string)) throw new Error("invalid clipboard atom");
    ids.add(attrs.id as string);
  }
}

export function remintClipboard(slice: Slice, mint: () => string = () => crypto.randomUUID(), assets: ReadonlySet<string> = new Set()): Slice {
  const originals = new Set<string>();
  const minted = new Set<string>();
  slice.content.descendants(node => {
    if (node.type.name !== "endnote" && node.type.name !== "figure") return;
    const original = node.attrs.id as string;
    if (originals.has(original)) throw new Error("duplicate clipboard instance ID");
    originals.add(original);
  });
  const walk = (node: PmNode): PmNode => {
    if (node.type.name === "endnote" || node.type.name === "figure") {
      const json = node.toJSON() as Record<string, unknown>;
      const content = node.isInline ? [{ type: "paragraph", content: [json] }] : [json];
      if (!validDocumentShape({ type: "doc", content })) throw new Error("invalid clipboard atom");
      const original = node.attrs.id as string;
      if (node.type.name === "figure" && !assets.has(node.attrs.asset_id as string)) throw new Error("clipboard figure asset unavailable");
      const id = mint();
      if (id === original || originals.has(id) || minted.has(id)) throw new Error("clipboard identity collision");
      minted.add(id);
      const result = node.type.create({ ...node.attrs, id });
      const replacement = node.isInline ? [{ type: "paragraph", content: [result.toJSON()] }] : [result.toJSON()];
      if (!validDocumentShape({ type: "doc", content: replacement })) throw new Error("invalid clipboard identity");
      return result;
    }
    if (node.isLeaf) return node;
    const children: PmNode[] = [];
    node.forEach(child => children.push(walk(child)));
    return node.copy(Fragment.from(children));
  };
  const children: PmNode[] = [];
  slice.content.forEach(node => children.push(walk(node)));
  return new Slice(Fragment.from(children), slice.openStart, slice.openEnd);
}
