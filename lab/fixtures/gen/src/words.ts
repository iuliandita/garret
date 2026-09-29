// lab/fixtures/gen/src/words.ts
import type { Prng } from "./prng";

export type Script = "latin" | "cjk" | "rtl";

const LATIN = (
  "the and a to of in she he it was said with for as her his that had on at " +
  "night door river stone light shadow voice hand eye road house winter storm " +
  "letter garden window silence memory promise stranger harbor lantern"
).split(" ");

const CJK = "春夏秋冬山川風雨雪月火水木金土人物語時間夜朝道家海空星雲".split("");
const RTL = (
  "אור צל בית דרך לילה זכרון קול יד עין נהר אבן חורף סער גן חלון " +
  "نور ظل بيت طريق ليل ذكرى صوت يد عين نهر حجر شتاء عاصفة حديقة نافذة"
).split(/\s+/).filter(Boolean);

export function countWords(text: string, script: Script): number {
  if (script === "cjk") return Array.from(text.replace(/[\s。、]/g, "")).length;
  return text.split(/\s+/).filter(Boolean).length;
}

function sentence(rng: Prng, script: Script, words: number): string {
  if (script === "cjk") {
    let s = "";
    for (let i = 0; i < words; i++) s += rng.pick(CJK);
    return s + "。";
  }
  const pool = script === "rtl" ? RTL : LATIN;
  const parts: string[] = [];
  for (let i = 0; i < words; i++) parts.push(rng.pick(pool));
  let s = parts.join(" ");
  if (script === "latin") s = s[0]!.toUpperCase() + s.slice(1);
  return s + ".";
}

export function paragraph(rng: Prng, script: Script, wordCount: number): string {
  const sentences: string[] = [];
  let remaining = wordCount;
  while (remaining > 0) {
    const n = Math.min(remaining, 4 + rng.int(14));
    sentences.push(sentence(rng, script, n));
    remaining -= n;
  }
  return sentences.join(" ");
}
