// lab/fixtures/gen/src/records.ts
import type { Prng } from "./prng";
import type { Item, KnowledgeRecord } from "./model";
import { paragraph } from "./words";

const KINDS = ["person", "place", "object", "custom", "research"] as const;
const NAMES = [
  "Mara", "Anselm", "Odessa", "Ilya", "Beatriz", "Havel", "Nadia",
  "Greystone Mill", "The Lantern House", "Rue d'Automne", "Kesäranta",
];

export function buildRecords(
  rng: Prng,
  count: number,
  items: Item[],
): KnowledgeRecord[] {
  const out: KnowledgeRecord[] = [];
  for (let i = 0; i < count; i++) {
    const kind = KINDS[i % KINDS.length]!;
    const name = `${rng.pick(NAMES)} ${rng.int(9999)}`;
    const linkCount = rng.int(4);
    const linked: string[] = [];
    for (let j = 0; j < linkCount; j++) linked.push(rng.pick(items).id);
    out.push({
      id: `kr-${i.toString().padStart(6, "0")}`,
      kind,
      name,
      aliases: rng.next() < 0.3 ? [`${name} (alias)`] : [],
      note: paragraph(rng, "latin", 30 + rng.int(60)),
      linkedItemIds: [...new Set(linked)],
    });
  }
  return out;
}
