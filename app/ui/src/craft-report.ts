import { schema } from "./editor";
import { foldForFind } from "./find-locate";
import { messages, t } from "./i18n";

export const REPORT_VERSION = 1;
export const MAX_REPORT_DOCUMENTS = 200;
export const MAX_REPORT_WORDS = 200_000;
export const MAX_REPORT_FINDINGS = 500;
export const MAX_WATCH_TERMS = 200;
export const MAX_WATCH_SCALARS = 200;

export interface ReportSource {
  item_id: string;
  title: string;
  rev: number;
  body: string;
}

export interface WatchTerm {
  text: string;
  mode: "literal" | "folded";
}

export interface ReportOptions {
  scope: "document" | "chapter" | "book";
  language: string;
  quote_convention: "ascii_double" | "curly_double";
  watchlist: readonly WatchTerm[];
  max_documents: number;
  max_words: number;
  max_findings: number;
}

export interface ReportFinding {
  kind: "adjacent_word" | "repeated_phrase" | "watchlist";
  class: "structural" | "suggestion";
  item_id: string;
  rev: number;
  from: number;
  to: number;
  excerpt: string;
  matched: string;
  term?: string;
}

export interface CraftReport {
  version: number;
  locale: string;
  options: ReportOptions;
  sources: { item_id: string; title: string; rev: number }[];
  coverage: {
    documents: number;
    words: number;
    unreadable_documents: string[];
    truncated_by: "documents" | "words" | "findings" | null;
  };
  definitions: {
    tokens: string;
    repeated_phrase: string;
    sentences: string;
    dialogue: string;
    readability: string;
    csv_text: string;
  };
  metrics: {
    paragraph_words: number[];
    sentence_words: number[];
    dialogue_words: number;
    unmatched_quotes: number;
    english_readability: number | null;
  };
  findings: ReportFinding[];
  knowledge: KnowledgeFinding[];
}

export interface KnowledgeFinding {
  kind: "unavailable_link" | "missing_resource" | "alias_collision" | "unused_entry";
  class: "structural" | "suggestion";
  caption: string;
  detail: string;
}

export function knowledgeConsistency(input: {
  links: readonly { source_caption: string; target_caption: string; source_available: boolean; target_available: boolean }[];
  resources: readonly { title: string; available: boolean; removed_at: number | null }[];
  cast: readonly { id: string; name: string; aliases: readonly string[] }[];
  appearances: Readonly<Record<string, readonly string[]>>;
}, maxFindings = MAX_REPORT_FINDINGS): KnowledgeFinding[] {
  const out: KnowledgeFinding[] = [];
  const push = (value: KnowledgeFinding): void => { if (out.length < maxFindings) out.push(value); };
  for (const link of input.links) {
    if (!link.source_available || !link.target_available) push({ kind: "unavailable_link", class: "structural",
      caption: link.source_caption, detail: link.target_caption });
  }
  for (const resource of input.resources) {
    if (!resource.available) push({ kind: "missing_resource", class: "structural", caption: resource.title,
      detail: resource.removed_at === null ? t("craft.missing") : t("craft.removed") });
  }
  const aliases = new Map<string, string>();
  const used = new Set(Object.values(input.appearances).flat());
  for (const member of input.cast) {
    if (!used.has(member.id)) push({ kind: "unused_entry", class: "suggestion", caption: member.name,
      detail: t("craft.consistency.no-appearance") });
    for (const alias of [member.name, ...member.aliases]) {
      const folded = foldForFind(alias);
      const previous = aliases.get(folded);
      if (previous !== undefined && previous !== member.id) push({ kind: "alias_collision", class: "structural",
        caption: alias, detail: member.name });
      aliases.set(folded, member.id);
    }
  }
  return out;
}

interface Block {
  text: string;
  from: number;
}

interface Token {
  text: string;
  folded: string;
  from: number;
  to: number;
}

const TOKEN = /[\p{L}\p{N}][\p{L}\p{M}\p{N}\x27’-]*/gu;

function boundedInteger(value: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name} must be between 1 and ${max}`);
  return value;
}

export function validateReportOptions(options: ReportOptions): ReportOptions {
  const max_documents = boundedInteger(options.max_documents, MAX_REPORT_DOCUMENTS, t("craft.limit.documents"));
  const max_words = boundedInteger(options.max_words, MAX_REPORT_WORDS, t("craft.limit.words"));
  const max_findings = boundedInteger(options.max_findings, MAX_REPORT_FINDINGS, t("craft.limit.findings"));
  if (options.watchlist.length > MAX_WATCH_TERMS) throw new Error("watchlist has too many terms");
  const watchlist = options.watchlist.map((term) => {
    const text = term.text.trim();
    if (!text || [...text].length > MAX_WATCH_SCALARS || !["literal", "folded"].includes(term.mode)) {
      throw new Error("watchlist term is empty, too long, or has an unknown mode");
    }
    return { text, mode: term.mode };
  });
  if (!["document", "chapter", "book"].includes(options.scope) ||
      !["ascii_double", "curly_double"].includes(options.quote_convention)) {
    throw new Error("report scope or quotation convention is unknown");
  }
  return { ...options, watchlist, max_documents, max_words, max_findings };
}

/** ProseMirror block positions count UTF-16 units; marks add no positions. */
function blocksOf(body: string): Block[] {
  const doc = schema.nodeFromJSON(JSON.parse(body) as object);
  doc.check();
  const blocks: Block[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "paragraph") blocks.push({ text: node.textContent, from: pos + 1 });
  });
  return blocks;
}

function tokensOf(block: Block): Token[] {
  const tokens: Token[] = [];
  for (const match of block.text.matchAll(TOKEN)) {
    const text = match[0];
    const from = block.from + match.index;
    tokens.push({ text, folded: foldForFind(text), from, to: from + text.length });
  }
  return tokens;
}

function excerpt(block: Block, from: number, to: number): string {
  const start = Math.max(0, from - block.from - 35);
  const end = Math.min(block.text.length, to - block.from + 35);
  return block.text.slice(start, end);
}

function sentenceCounts(text: string): number[] {
  const out: number[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!".!?".includes(text[i] ?? "") || (i + 1 < text.length && !/\s/.test(text[i + 1] ?? ""))) continue;
    const count = [...text.slice(start, i + 1).matchAll(TOKEN)].length;
    if (count > 0) out.push(count);
    start = i + 1;
  }
  const tail = [...text.slice(start).matchAll(TOKEN)].length;
  if (tail > 0) out.push(tail);
  return out;
}

function syllables(word: string): number {
  const clean = foldForFind(word).replace(/[^a-z]/g, "");
  if (!clean) return 0;
  const clusters = clean.replace(/e$/, "").match(/[aeiouy]+/g)?.length ?? 0;
  return Math.max(1, clusters);
}

function dialogueRanges(text: string, convention: ReportOptions["quote_convention"]): { ranges: [number, number][]; unmatched: number } {
  const ranges: [number, number][] = [];
  let start = -1;
  let unmatched = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (convention === "ascii_double") {
      if (ch !== '"') continue;
      if (start < 0) start = i + 1;
      else { ranges.push([start, i]); start = -1; }
    } else if (ch === "“") {
      if (start >= 0) unmatched++;
      start = i + 1;
    } else if (ch === "”") {
      if (start < 0) unmatched++;
      else { ranges.push([start, i]); start = -1; }
    }
  }
  if (start >= 0) unmatched++;
  return { ranges, unmatched };
}

function foldedProjection(text: string): { text: string; starts: number[]; ends: number[] } {
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const point of text) {
    const lower = foldForFind(point);
    folded += lower;
    for (let i = 0; i < lower.length; i++) {
      starts.push(offset);
      ends.push(offset + point.length);
    }
    offset += point.length;
  }
  return { text: folded, starts, ends };
}

export function createCraftReport(input: ReportOptions): {
  add(source: ReportSource): boolean;
  finish(): CraftReport;
} {
  const options = validateReportOptions(input);
  const report: CraftReport = {
    version: REPORT_VERSION,
    locale: messages.locale,
    options,
    sources: [],
    coverage: { documents: 0, words: 0, unreadable_documents: [], truncated_by: null },
    definitions: {
      tokens: t("craft.def.tokens"),
      repeated_phrase: t("craft.def.repeated_phrase"),
      sentences: t("craft.def.sentences"),
      dialogue: t("craft.def.dialogue"),
      readability: t("craft.def.readability"),
      csv_text: t("craft.def.csv_text"),
    },
    metrics: { paragraph_words: [], sentence_words: [], dialogue_words: 0, unmatched_quotes: 0, english_readability: null },
    findings: [],
    knowledge: [],
  };
  let syllableTotal = 0;

  const finding = (value: ReportFinding): void => {
    if (report.findings.length >= options.max_findings) {
      report.coverage.truncated_by = "findings";
      return;
    }
    report.findings.push(value);
  };

  function add(source: ReportSource): boolean {
    if (report.coverage.truncated_by !== null) return false;
    if (report.coverage.documents >= options.max_documents) {
      report.coverage.truncated_by = "documents";
      return false;
    }
    let blocks: Block[];
    try { blocks = blocksOf(source.body); }
    catch {
      report.coverage.unreadable_documents.push(source.item_id);
      return true;
    }
    const tokenBlocks = blocks.map(tokensOf);
    const words = tokenBlocks.reduce((sum, tokens) => sum + tokens.length, 0);
    if (report.coverage.words + words > options.max_words) {
      report.coverage.truncated_by = "words";
      return false;
    }
    report.sources.push({ item_id: source.item_id, title: source.title, rev: source.rev });
    report.coverage.documents++;
    report.coverage.words += words;
    for (const [index, block] of blocks.entries()) {
      const tokens = tokenBlocks[index] ?? [];
      report.metrics.paragraph_words.push(tokens.length);
      report.metrics.sentence_words.push(...sentenceCounts(block.text));
      const dialogue = dialogueRanges(block.text, options.quote_convention);
      report.metrics.unmatched_quotes += dialogue.unmatched;
      for (const token of tokens) {
        syllableTotal += syllables(token.text);
        const localStart = token.from - block.from;
        const localEnd = token.to - block.from;
        if (dialogue.ranges.some(([from, to]) => localStart >= from && localEnd <= to)) report.metrics.dialogue_words++;
      }
      for (let i = 1; i < tokens.length; i++) {
        const previous = tokens[i - 1]!;
        const current = tokens[i]!;
        if (previous.folded === current.folded && /^\s+$/.test(block.text.slice(previous.to - block.from, current.from - block.from))) {
          finding({ kind: "adjacent_word", class: "structural", item_id: source.item_id, rev: source.rev,
            from: current.from, to: current.to, excerpt: excerpt(block, current.from, current.to), matched: current.text });
        }
      }
      const seen = new Map<string, number>();
      for (let i = 0; i + 2 < tokens.length; i++) {
        const phrase = tokens.slice(i, i + 3).map((token) => token.folded).join("\u0000");
        const prior = seen.get(phrase);
        if (prior !== undefined && i - prior <= 100) {
          const first = tokens[i]!;
          const last = tokens[i + 2]!;
          finding({ kind: "repeated_phrase", class: "suggestion", item_id: source.item_id, rev: source.rev,
            from: first.from, to: last.to, excerpt: excerpt(block, first.from, last.to),
            matched: block.text.slice(first.from - block.from, last.to - block.from) });
        }
        seen.set(phrase, i);
      }
      const folded = foldedProjection(block.text);
      for (const term of options.watchlist) {
        const haystack = term.mode === "folded" ? folded.text : block.text;
        const needle = term.mode === "folded" ? foldForFind(term.text) : term.text;
        let at = haystack.indexOf(needle);
        while (at >= 0) {
          const final = at + needle.length - 1;
          if (term.mode === "folded" &&
            ((at > 0 && folded.starts[at] === folded.starts[at - 1]) ||
              (final + 1 < folded.ends.length && folded.ends[final] === folded.ends[final + 1]))) {
            at = haystack.indexOf(needle, at + Math.max(1, needle.length));
            continue;
          }
          const localFrom = term.mode === "folded" ? folded.starts[at] : at;
          const localTo = term.mode === "folded" ? folded.ends[final] : at + needle.length;
          if (localFrom !== undefined && localTo !== undefined) {
            const from = block.from + localFrom;
            const to = block.from + localTo;
            finding({ kind: "watchlist", class: "structural", item_id: source.item_id, rev: source.rev,
              from, to, excerpt: excerpt(block, from, to), matched: block.text.slice(localFrom, localTo), term: term.text });
          }
          at = haystack.indexOf(needle, at + Math.max(1, needle.length));
        }
      }
    }
    return report.coverage.truncated_by === null;
  }

  function finish(): CraftReport {
    const sentences = report.metrics.sentence_words.length;
    if (options.language.toLowerCase().startsWith("en") && report.coverage.words > 0 && sentences > 0) {
      report.metrics.english_readability = Math.round((206.835 -
        1.015 * report.coverage.words / sentences -
        84.6 * syllableTotal / report.coverage.words) * 10) / 10;
    }
    return report;
  }

  return { add, finish };
}

function csvCell(value: unknown, text: boolean): string {
  let cell = String(value ?? "");
  if (text && /^[\s\u0000-\u001f]*[=+\-@]/.test(cell)) cell = `'${cell}`;
  if (text && /^[\u0000-\u001f]/.test(cell)) cell = `'${cell}`;
  return '"' + cell.replaceAll('"', '""') + '"';
}

export function craftReportCsv(report: CraftReport): string {
  const rows: unknown[][] = [["row_type", "kind", "item_id", "rev", "from", "to", "matched", "excerpt", "details"]];
  rows.push(["coverage", "", "", "", "", "", "", "", JSON.stringify({
    version: report.version, locale: report.locale, options: report.options, coverage: report.coverage,
    definitions: report.definitions, metrics: report.metrics, sources: report.sources,
  })]);
  for (const finding of report.findings) {
    rows.push(["finding", finding.kind, finding.item_id, finding.rev, finding.from, finding.to,
      finding.matched, finding.excerpt, JSON.stringify({ class: finding.class, term: finding.term ?? null })]);
  }
  for (const finding of report.knowledge) {
    rows.push(["knowledge", finding.kind, "", "", "", "", finding.caption, finding.detail, finding.class]);
  }
  return rows.map((row) => row.map((cell, index) => csvCell(cell, ![3, 4, 5].includes(index))).join(",")).join("\r\n") + "\r\n";
}
