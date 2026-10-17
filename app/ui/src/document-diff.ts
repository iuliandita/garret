import type { Node as PmNode } from "prosemirror-model";
import { t } from "./i18n";
import { readableBody, schema } from "./editor";
import { documentFields, proseText, type DocumentField } from "./document-projections";
import { diffWords, summarize, type DiffPiece } from "./diff";

export interface FieldDiff {
  field: DocumentField | "structure";
  instance_id: string | null;
  pieces: DiffPiece[];
  added: number;
  removed: number;
}

function structure(doc: PmNode): string {
  const blocks: unknown[] = [];
  doc.forEach(block => {
    if (block.type.name === "paragraph") {
      const notes: unknown[] = [];
      block.forEach((child, offset) => {
        if (child.type.name === "endnote") notes.push([child.attrs.id, offset]);
      });
      blocks.push(["paragraph", notes]);
    } else if (block.type.name === "figure") {
      blocks.push(["figure", block.attrs.id, block.attrs.asset_id, block.attrs.width]);
    } else blocks.push([block.type.name]);
  });
  return JSON.stringify(blocks);
}

export function diffDocumentFields(before: string, after: string): FieldDiff[] {
  const fields = (body: string) => {
    const raw = readableBody(body);
    if (raw === null) throw new Error("unsupported history document");
    const doc = schema.nodeFromJSON(raw);
    return { structure: structure(doc), fields: [{ field: "prose" as const, instance_id: null, text: proseText(doc, "\n\n") },
      ...documentFields(doc).filter(field => field.field !== "prose")] };
  };
  const oldFields = fields(before);
  const newFields = fields(after);
  const key = (field: { field: DocumentField; instance_id: string | null }) => field.field + ":" + (field.instance_id ?? "");
  const oldById = new Map(oldFields.fields.map(field => [key(field), field]));
  const newById = new Map(newFields.fields.map(field => [key(field), field]));
  const keys = new Set([...oldById.keys(), ...newById.keys()]);
  const changes: FieldDiff[] = [...keys].map(id => {
    const oldField = oldById.get(id);
    const newField = newById.get(id);
    const field = newField ?? oldField!;
    const pieces = diffWords(oldField?.text ?? "", newField?.text ?? "");
    return { field: field.field, instance_id: field.instance_id, pieces, ...summarize(pieces) };
  });
  if (oldFields.structure !== newFields.structure) changes.push({
    field: "structure", instance_id: null,
    pieces: [{ op: "same", text: t("history.diff.structure-changed") }], added: 0, removed: 0,
  });
  return changes;
}
