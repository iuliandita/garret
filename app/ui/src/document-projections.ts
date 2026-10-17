import type { Fragment, Node as PmNode } from "prosemirror-model";

export type DocumentField = "prose" | "note" | "caption" | "alt";
export interface TextField {
  instance_id: string | null;
  field: DocumentField;
  text: string;
  from: number;
  to: number;
}

export function proseText(doc: PmNode, separator = " "): string {
  const blocks: string[] = [];
  doc.forEach(block => {
    if (block.type.name !== "paragraph") return;
    let text = "";
    block.forEach(child => { if (child.isText) text += child.text; });
    blocks.push(text);
  });
  return blocks.join(separator);
}

export function documentFields(doc: PmNode): TextField[] {
  const fields: TextField[] = [];
  doc.forEach((block, pos) => {
    if (block.type.name === "figure") {
      for (const field of ["caption", "alt"] as const) fields.push({
        instance_id: block.attrs.id as string, field, text: block.attrs[field] as string, from: pos, to: pos + 1,
      });
    } else if (block.type.name === "paragraph") {
      let text = "";
      let from = pos + 1;
      const finish = (): void => {
        if (text) fields.push({ instance_id: null, field: "prose", text, from, to: from + text.length });
        text = "";
      };
      block.forEach((child, offset) => {
        if (child.isText) text += child.text;
        else {
          finish();
          fields.push({ instance_id: child.attrs.id as string, field: "note", text: child.attrs.body as string,
            from: pos + 1 + offset, to: pos + 2 + offset });
          from = pos + 2 + offset;
        }
      });
      finish();
    }
  });
  return fields;
}

export interface PlaintextLabels {
  note: string;
  figure: string;
  caption: string;
  alt: string;
  loss: string;
}

export function plaintext(content: Fragment, labels: PlaintextLabels): string {
  return serializePlaintext(content, labels, true);
}

export function clipboardPlaintext(content: Fragment, labels: PlaintextLabels): string {
  return serializePlaintext(content, labels, false);
}

function serializePlaintext(content: Fragment, labels: PlaintextLabels, recovery: boolean): string {
  const blocks: string[] = [];
  const notes: string[] = [];
  let lossy = false;
  let inline = false;
  const pushInline = (text: string): void => {
    if (inline) blocks[blocks.length - 1] += text;
    else blocks.push(text);
    inline = true;
  };
  content.forEach(block => {
    if (!block.isInline) inline = false;
    if (recovery && block.marks.length) lossy = true;
    if (block.type.name === "paragraph") {
      let text = "";
      block.forEach(child => {
        if (child.isText) { text += child.text; if (recovery && child.marks.length) lossy = true; }
        else if (child.type.name === "endnote") {
          notes.push(`[${notes.length + 1}] ${child.attrs.body as string}`);
          text += `[${notes.length}]`;
          lossy = true;
        } else throw new Error("unsupported plaintext node");
      });
      blocks.push(text);
    } else if (block.type.name === "figure") {
      blocks.push(`[${labels.figure}]\n${labels.caption}: ${block.attrs.caption as string}\n${labels.alt}: ${block.attrs.alt as string}`);
      lossy = true;
    } else if (block.type.name === "scene_break") {
      blocks.push("* * *");
      lossy = true;
    } else if (block.isText) pushInline(block.text ?? "");
    else if (block.type.name === "endnote") {
      notes.push(`[${notes.length + 1}] ${block.attrs.body as string}`);
      pushInline(`[${notes.length}]`);
      lossy = true;
    } else throw new Error("unsupported plaintext node");
  });
  if (notes.length) blocks.push(`${labels.note}\n${notes.join("\n\n")}`);
  if (lossy) blocks.push(labels.loss);
  return blocks.join("\n\n");
}

/** One code unit per atom keeps quotes and spelling in manuscript coordinates. */
export function positionalText(doc: PmNode, from: number, to: number): string {
  return doc.textBetween(from, to, " ", "\ufffc");
}
