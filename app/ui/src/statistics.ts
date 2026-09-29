// app/ui/src/statistics.ts
// What the manuscript measures, and what each measurement means.
//
// PURE. No DOM, no IPC, no clock. Everything here takes the walk and the host's
// per-document counts and returns numbers and sentences; `statistics-panel.ts`
// is the only thing that paints them. That split is not tidiness - logic that
// lives in a file a test cannot import goes uncovered here, and the recorded way
// that is found is a mutation surviving the whole suite.
//
// NOTHING HERE RUNS ON THE KEYSTROKE PATH, and the only entry point that could
// is `createSessionWords`. Its `observe` is one map lookup and two additions,
// and its callers are the scene count's THROTTLE and the navigator's 4-second
// count refresh - never `onChange`. The recorded regression is a full-manuscript
// scan on the flush path costing a measurable frame tail while every scalar gate
// stayed green, and the shape of it, not the size, is what this comment is for.
//
// THE WORD RULE IS NOT RESTATED. Every figure below is arithmetic over counts
// the host computed with `words.rs`, which is pinned case-for-case to `words.ts`.
// A third statement of "what is a word" is exactly what that pair exists to
// prevent.
import { formatDateTime, formatNumber, t } from "./i18n";
import { BACK_MATTER_TYPE, FRONT_MATTER_TYPE } from "./item-types";
import { manuscriptItemsIn } from "./outline";
import { rollUpMetric, type DocumentCounts, type DocumentStatisticsCounts } from "./outline-counts";
import {
  NO_STATE_LABEL,
  REVISION_STATES,
  STATE_LABELS,
  stateDistribution,
  type StateDistribution,
} from "./revision-states";
import type { ProjectItem } from "./store/source";
import { formatMinutes, type TimeTracking } from "./writing-time";

/** The item type that carries a document. Restated from the store, like
 *  `TRASH_TYPE` in `outline.ts` and for the same reason: there is no import
 *  across that boundary, and a drift shows up as a scene count that disagrees
 *  with the navigator rather than as a silent zero. */
export const SCENE_TYPE = "scene";
export const CHAPTER_TYPE = "chapter";
export const PART_TYPE = "part";

/** Words gained and words lost since this window opened, KEPT APART.
 *
 *  The bar shows a net figure and a net figure alone cannot tell an afternoon
 *  spent drafting from one spent drafting and cutting the same amount back out.
 *  The spec asks for added, deleted and net as three measurements; this is the
 *  two that the net is derived from. */
export interface SessionTotals {
  readonly added: number;
  readonly deleted: number;
  readonly net: number;
}

/** Why a scope has no number, so a reader is never shown a zero that is really
 *  an absence.
 *
 *  `absent` - there is no such scope: no scene is open, or the open scene has no
 *  chapter above it. The hierarchy is free-form by product decision, so "inside
 *  a chapter" is a fact about this manuscript rather than a guarantee.
 *  `uncounted` - the scope exists and the host could not count what is in it. */
export type ScopeState = "counted" | "absent" | "uncounted";

export interface ScopeTotal {
  readonly state: ScopeState;
  /** null unless `state` is `counted`. */
  readonly words: number | null;
  /** The title of the item this scope is, when there is one, so a reader can
   *  see WHICH chapter the figure is about. */
  readonly title: string | null;
}

export interface Structure {
  readonly parts: number;
  readonly chapters: number;
  readonly scenes: number;
}

export interface SceneLengths {
  /** null when nothing could be counted at all. */
  readonly longest: number | null;
  readonly shortest: number | null;
  /** May be fractional: with an even number of scenes it is the mean of the two
   *  central values. */
  readonly median: number | null;
  /** Readable bodies holding no words. A real value, and NOT the same thing as
   *  `uncounted`. */
  readonly empty: number;
  /** Scenes the host returned no count for. Every figure above leaves them out
   *  rather than treating them as zero. */
  readonly uncounted: number;
}

/** The manuscript total split by SECTION: the chapters, the front matter, the
 *  back matter. The whole-manuscript figure describes the FILE the writer
 *  exports, dedication and all, and it must keep agreeing with the bar and the
 *  export (`export_word_count_agrees`). What a writer quotes to an agent is the
 *  chapters alone, and before this the panel had no such number: a dedication's
 *  words counted toward the goal and nothing said how many. A breakdown, NOT a
 *  filter -- the total is untouched and each of these is a part of it.
 *  `front`/`back` are `absent` when the book has no such root. */
export interface Sections {
  readonly chapters: ScopeTotal;
  readonly front: ScopeTotal;
  readonly back: ScopeTotal;
}

/** Sentences and paragraphs, counted by the host from the same projection of
 *  a body it counts words from. The rules are in `words.rs` and have no page
 *  twin: nothing here counts them, so a twin would be a rule nobody calls. */
export interface Units {
  readonly sentences: number;
  readonly paragraphs: number;
}

/** The units derived from the same sparse projection as words. */
export interface UnitFigures {
  readonly manuscript: Units | null;
  readonly scene: Units | null;
  readonly chapter: Units | null;
  readonly part: Units | null;
}

export interface Statistics {
  readonly scene: ScopeTotal;
  readonly chapter: ScopeTotal;
  readonly part: ScopeTotal;
  readonly manuscript: ScopeTotal;
  readonly sections: Sections;
  readonly structure: Structure;
  readonly lengths: SceneLengths;
  /** How many items stand where. Over EVERY item type, not only scenes: a
   *  writer marks a whole chapter `revising`, so counting scenes alone would
   *  report a book nobody had marked. */
  readonly states: StateDistribution;
  readonly session: SessionTotals;
  readonly today: TodayFigures;
  readonly units: UnitFigures;
}

/** What the host holds about today, separate from the session because it is
 *  STORED and turns at local midnight, which the session figures do not. */
export interface SourceWordSummary {
  readonly available: boolean;
  /** False while this book's saves are not being measured. */
  readonly collecting: boolean;
  /** Collection was paused and resumed since `started_at`: the totals have a
   *  hole the writer must be told about. */
  readonly interrupted: boolean;
  readonly started_at: number | null;
  readonly totals: Record<"typing" | "pasted" | "imported" | "restored" | "unattributed", { added: number; deleted: number }>;
  readonly today_typing: number | null;
  readonly warning: string | null;
}

export interface TodayFigures {
  readonly sources?: SourceWordSummary;
  /** Minutes with an edit, or null when the host could not say. */
  readonly writingMinutes: number | null;
  readonly tracking: TimeTracking;
}

export interface StatisticsInput {
  /** The walk as the store reports it, bin and all. The bin is removed here
   *  rather than by the caller, so no caller can forget to. */
  readonly items: readonly ProjectItem[];
  /** The host's per-document counts. Already sparse and already bin-free:
   *  `counts_excluding` withholds a trashed document and a document it could
   *  not read, and the difference between the two is the walk. */
  readonly perDoc: DocumentStatisticsCounts;
  /** The scene the editor is showing, or null. */
  readonly openItemId: string | null;
  readonly session: SessionTotals;
  readonly today: TodayFigures;
}

/** The nearest ancestor of `type` at or above `id`, or null.
 *
 *  AT OR ABOVE: an open item that is itself a chapter is its own chapter scope,
 *  which is the answer a reader expects and the only one that does not depend on
 *  what an item is allowed to contain. Product spec section 6 makes the
 *  hierarchy arbitrary - a part may sit inside a scene - so this walks the chain
 *  and takes the first match rather than assuming a depth.
 */
function nearestOfType(
  byId: Map<string, ProjectItem>,
  id: string | null,
  type: string,
): ProjectItem | null {
  let cursor = id === null ? undefined : byId.get(id);
  // Bounded by the chain length, and a walk whose parent is missing stops
  // rather than looping: `liveItemsIn` can drop a parent this item still names
  // only if the parent was binned, in which case the child was dropped too.
  const seen = new Set<string>();
  while (cursor !== undefined && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    if (cursor.type === type) return cursor;
    cursor = cursor.parent_id === null ? undefined : byId.get(cursor.parent_id);
  }
  return null;
}

function sectionTotal(present: boolean, words: number | null): ScopeTotal {
  if (!present) return { state: "absent", words: null, title: null };
  if (words === null) return { state: "uncounted", words: null, title: null };
  return { state: "counted", words, title: null };
}

function scopeOf(item: ProjectItem | null, totals: Map<string, number>): ScopeTotal {
  if (item === null) return { state: "absent", words: null, title: null };
  const words = totals.get(item.id);
  if (words === undefined) return { state: "uncounted", words: null, title: item.title };
  return { state: "counted", words, title: item.title };
}

function unitsOf(item: ProjectItem | null, perDoc: DocumentStatisticsCounts): Units | null {
  if (item === null) return null;
  const own = Object.prototype.hasOwnProperty.call(perDoc, item.id) ? perDoc[item.id] : undefined;
  return own === undefined ? null : { sentences: own.sentences, paragraphs: own.paragraphs };
}

function rolledUnits(
  item: ProjectItem | null,
  sentences: Map<string, number>,
  paragraphs: Map<string, number>,
): Units | null {
  if (item === null) return null;
  const sentenceCount = sentences.get(item.id);
  const paragraphCount = paragraphs.get(item.id);
  if (sentenceCount === undefined || paragraphCount === undefined) return null;
  return { sentences: sentenceCount, paragraphs: paragraphCount };
}

/** The middle of a sorted list of counts.
 *
 *  The MEAN of the two central values on an even count, which can be a half.
 *  Rounding here would be a number nobody could reproduce from the list, and the
 *  formatter below prints the half rather than hiding it.
 */
export function medianOf(sorted: readonly number[]): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid] ?? null;
  const a = sorted[mid - 1];
  const b = sorted[mid];
  if (a === undefined || b === undefined) return null;
  return (a + b) / 2;
}

/**
 * Everything the panel shows, from the walk and one map.
 *
 * ONE PASS for the structure and one sort for the lengths, over a walk that is
 * 20,060 rows at the stress fixture. Called when the panel OPENS and at no other
 * time: nothing here is on a timer and nothing here is armed by a flush.
 */
export function computeStatistics(input: StatisticsInput): Statistics {
  // THE BOOK, not merely what is not deleted. The manuscript total is summed
  // over ROOTS, so a second root goes straight into `manuscript` and
  // `rollUpCounts` rolls the bible's words up into it -- and every structure
  // figure beside it would count rows the writer keeps for reference.
  const live = manuscriptItemsIn(input.items);
  const byId = new Map(live.map((item) => [item.id, item]));
  const totals = rollUpMetric(live, input.perDoc, (count) => count.words);
  const sentenceTotals = rollUpMetric(live, input.perDoc, (count) => count.sentences);
  const paragraphTotals = rollUpMetric(live, input.perDoc, (count) => count.paragraphs);

  let parts = 0;
  let chapters = 0;
  let scenes = 0;
  let empty = 0;
  let uncounted = 0;
  let manuscript = 0;
  /** True once ANY document has been counted. A manuscript whose every scene is
   *  unreadable must report an unknown total, not a zero one - the same rule the
   *  host follows when it withholds an entry rather than writing 0. */
  let counted = false;
  const sceneWords: number[] = [];
  // Per-section sums over ROOTS, the same arithmetic as `manuscript` so the
  // three always add up to it. `null` until a root of that kind is seen.
  let chaptersWords: number | null = null;
  let frontWords: number | null = null;
  let backWords: number | null = null;
  let frontRoots = 0;
  let backRoots = 0;

  for (const item of live) {
    if (item.type === PART_TYPE) parts += 1;
    else if (item.type === CHAPTER_TYPE) chapters += 1;
    else if (item.type === SCENE_TYPE) scenes += 1;

    // The manuscript total is the sum over ROOTS of the rolled-up subtrees, so
    // it is the same arithmetic as every scope figure beside it. Summing
    // `perDoc` directly would be the host's own answer and would be right, but
    // the two could then disagree while both being defensible, and a reader
    // cannot audit a total that was computed a different way from its parts.
    if (item.parent_id === null) {
      const total = totals.get(item.id);
      if (item.type === FRONT_MATTER_TYPE) frontRoots += 1;
      else if (item.type === BACK_MATTER_TYPE) backRoots += 1;
      if (total !== undefined) {
        manuscript += total;
        counted = true;
        if (item.type === FRONT_MATTER_TYPE) frontWords = (frontWords ?? 0) + total;
        else if (item.type === BACK_MATTER_TYPE) backWords = (backWords ?? 0) + total;
        else chaptersWords = (chaptersWords ?? 0) + total;
      }
    }

    if (item.type !== SCENE_TYPE) continue;
    const own = Object.prototype.hasOwnProperty.call(input.perDoc, item.id)
      ? input.perDoc[item.id]
      : undefined;
    if (own === undefined) {
      uncounted += 1;
      continue;
    }
    sceneWords.push(own.words);
    if (own.words === 0) empty += 1;
  }

  sceneWords.sort((a, b) => a - b);
  const manuscriptUnits = counted
    ? {
        sentences: live
          .filter((item) => item.parent_id === null)
          .reduce((sum, item) => sum + (sentenceTotals.get(item.id) ?? 0), 0),
        paragraphs: live
          .filter((item) => item.parent_id === null)
          .reduce((sum, item) => sum + (paragraphTotals.get(item.id) ?? 0), 0),
      }
    : null;

  return {
    scene: scopeOf(
      input.openItemId === null ? null : (byId.get(input.openItemId) ?? null),
      totals,
    ),
    chapter: scopeOf(nearestOfType(byId, input.openItemId, CHAPTER_TYPE), totals),
    part: scopeOf(nearestOfType(byId, input.openItemId, PART_TYPE), totals),
    manuscript: counted
      ? { state: "counted", words: manuscript, title: null }
      : { state: "uncounted", words: null, title: null },
    sections: {
      // The chapters are never `absent`: a book with no chapter root at all is
      // the empty state the panel already has, and an unreadable one is uncounted.
      chapters: sectionTotal(true, chaptersWords),
      front: sectionTotal(frontRoots > 0, frontWords),
      back: sectionTotal(backRoots > 0, backWords),
    },
    structure: { parts, chapters, scenes },
    lengths: {
      longest: sceneWords.at(-1) ?? null,
      shortest: sceneWords[0] ?? null,
      median: medianOf(sceneWords),
      empty,
      uncounted,
    },
    // Over the live walk, so the bin is already gone: an item the writer deleted
    // is not part of how far the manuscript has got. One pass, and it is the
    // same `live` array every figure above is computed from.
    states: stateDistribution(live),
    session: input.session,
    today: input.today,
    units: {
      manuscript: manuscriptUnits,
      scene: unitsOf(input.openItemId === null ? null : (byId.get(input.openItemId) ?? null), input.perDoc),
      chapter: rolledUnits(nearestOfType(byId, input.openItemId, CHAPTER_TYPE), sentenceTotals, paragraphTotals),
      part: rolledUnits(nearestOfType(byId, input.openItemId, PART_TYPE), sentenceTotals, paragraphTotals),
    },
  };
}

// ------------------------------------------------------------------ session

export interface SessionWords {
  /** One document's current word count. The FIRST call for an id sets its
   *  baseline and moves nothing: a manuscript that was already 80,000 words
   *  when the window opened was not written this session. */
  observe(itemId: string, words: number): void;
  /** Every document in one map, optionally skipping one.
   *
   *  `skip` is the OPEN document, and skipping it is load-bearing. This map is
   *  what the store holds; the open scene's live count runs ahead of it by up to
   *  a flush debounce, and feeding both would read that lag as words deleted and
   *  then written again. */
  observeAll(counts: DocumentCounts, skip?: string | null): void;
  totals(): SessionTotals;
}

/**
 * Words gained and lost since this window opened.
 *
 * PER WINDOW, AND NOT STORED. A session counter in the store is a schema change
 * and an argument about when a session ends - a question with no answer that is
 * true for a writer who leaves the application open for a week. This dies with
 * the project, which is a definition anybody can check against their own memory.
 *
 * SAMPLED, NOT KEYSTROKE-BY-KEYSTROKE, and the honest consequence is stated in
 * the panel: a word typed and removed again between two samples cancels out and
 * appears in neither figure. Observing every keystroke is the one thing this
 * measurement is forbidden to do.
 *
 * AN ABSENT DOCUMENT IS NOT A DELETED ONE. `counts_excluding` withholds a
 * trashed document and one it could not read, and the two are indistinguishable
 * from here. Charging the disappearance as words deleted would report a failed
 * parse as a writer cutting a chapter, so a baseline is only ever moved by a
 * count that arrived.
 */
export function createSessionWords(): SessionWords {
  const baseline = new Map<string, number>();
  let added = 0;
  let deleted = 0;

  function observe(itemId: string, words: number): void {
    const before = baseline.get(itemId);
    baseline.set(itemId, words);
    if (before === undefined) return;
    const delta = words - before;
    if (delta > 0) added += delta;
    else if (delta < 0) deleted += -delta;
  }

  return {
    observe,
    observeAll(counts: DocumentCounts, skip?: string | null): void {
      for (const [id, words] of Object.entries(counts)) {
        if (skip !== undefined && skip !== null && id === skip) continue;
        observe(id, words);
      }
    },
    totals(): SessionTotals {
      return { added, deleted, net: added - deleted };
    },
  };
}

// ------------------------------------------------------------------ rendering

/** One measured figure, with the sentence that says what it counts.
 *
 *  THE DEFINITION TRAVELS WITH THE NUMBER. Spec section 11 requires every metric
 *  to expose its definition, scope and exclusions; a statistic whose rule lives
 *  in a document nobody opens is a number a writer has to trust rather than
 *  check, and this application's whole argument is that they should not have to.
 */
export interface StatRow {
  readonly key: string;
  readonly label: string;
  /** Already formatted. A word when there is no number, never `0`: "none"
   *  where the scope does not exist, "not counted" where it could not be
   *  measured (243; the glyph it replaced said neither). */
  readonly value: string;
  /** THE NUMBER ITSELF, for the CSV/JSON export. null where `value` shows the
   *  dash: an absence stays an absence in a data file too, and an empty cell
   *  is what a spreadsheet reads as one. A zero here is always a real reading. */
  readonly raw: number | null;
  /** Which item the figure is about, when that is not obvious. */
  readonly detail: string | null;
  readonly definition: string;
}

export interface StatGroup {
  readonly heading: string;
  readonly rows: readonly StatRow[];
}

/** The two exclusions almost every figure shares, in ONE short clause.
 *
 *  Stated per figure rather than only in the footnote below, because a
 *  definition a reader has to assemble from two places is one they will get
 *  wrong - and kept to a single sentence because the first draft spelled both
 *  out in full on nine rows, which pushed the session figures and the footnote
 *  itself below the panel's fold. That is the recorded shortcuts-panel failure,
 *  and a screenshot is what found it here too. */
const EXCLUDES = t("stats.excludes");

/** The revision counts read the TREE and never a word count, so the
 *  unreadable-scene half of `EXCLUDES` does not apply to them: a scene whose
 *  body this build cannot parse still has a title, a type and a state. Saying
 *  the shorter thing is the whole point of a definition travelling with its
 *  number. */
const EXCLUDES_TREE = t("stats.excludes.tree");

/** No such scope: no scene is open, no chapter holds it, no front matter. */
const NONE = t("stats.value.none");
/** The figure exists but could not be read. */
const UNCOUNTED = t("stats.value.uncounted");

function words(n: number | null): string {
  return n === null ? UNCOUNTED : formatNumber(n);
}

function scopeValue(scope: ScopeTotal): string {
  if (scope.state === "absent") return NONE;
  return scope.state === "counted" ? words(scope.words) : UNCOUNTED;
}

function scopeDetail(scope: ScopeTotal, absent: string): string | null {
  if (scope.state === "absent") return absent;
  if (scope.state === "uncounted")
    return scope.title === null
      ? t("stats.scope.uncounted")
      : t("stats.scope.uncounted.titled", { title: scope.title });
  return scope.title;
}

/** A signed figure for the session, where zero is a real and common answer and
 *  must read as one. The minus sign is U+2212, the same character the bar's
 *  today figure uses and for the same reason. */
function signed(n: number): string {
  if (n < 0) return `−${formatNumber(Math.abs(n))}`;
  return formatNumber(n);
}

/**
 * The panel's content, as data.
 *
 * Returned rather than painted so the definitions are testable without a DOM,
 * and so a wording change is a diff in one place rather than in a builder.
 */
export function statisticRows(stats: Statistics): readonly StatGroup[] {
  return [
    {
      heading: t("stats.group.words"),
      rows: [
        {
          key: "scene",
          label: t("stats.row.scene"),
          value: scopeValue(stats.scene),
          raw: stats.scene.words,
          detail: scopeDetail(stats.scene, t("stats.absent.scene")),
          definition: t("stats.def.scene", { excludes: EXCLUDES }),
        },
        {
          key: "chapter",
          label: t("stats.row.chapter"),
          value: scopeValue(stats.chapter),
          raw: stats.chapter.words,
          detail: scopeDetail(stats.chapter, t("stats.absent.chapter")),
          definition: t("stats.def.chapter", { excludes: EXCLUDES }),
        },
        {
          key: "part",
          label: t("stats.row.part"),
          value: scopeValue(stats.part),
          raw: stats.part.words,
          detail: scopeDetail(stats.part, t("stats.absent.part")),
          definition: t("stats.def.part", { excludes: EXCLUDES }),
        },
        {
          key: "manuscript",
          label: t("stats.row.manuscript"),
          value: scopeValue(stats.manuscript),
          raw: stats.manuscript.words,
          detail: null,
          definition: t("stats.def.manuscript", { excludes: EXCLUDES }),
        },
      ],
    },
    {
      heading: t("stats.group.units"),
      rows: [
        unitRow("scene-sentences", "sentences", stats.units.scene, "scene", stats.scene.state),
        unitRow("scene-paragraphs", "paragraphs", stats.units.scene, "scene", stats.scene.state),
        unitRow("chapter-sentences", "sentences", stats.units.chapter, "chapter", stats.chapter.state),
        unitRow("chapter-paragraphs", "paragraphs", stats.units.chapter, "chapter", stats.chapter.state),
        unitRow("part-sentences", "sentences", stats.units.part, "part", stats.part.state),
        unitRow("part-paragraphs", "paragraphs", stats.units.part, "part", stats.part.state),
        unitRow("manuscript-sentences", "sentences", stats.units.manuscript, "manuscript", stats.manuscript.state),
        unitRow("manuscript-paragraphs", "paragraphs", stats.units.manuscript, "manuscript", stats.manuscript.state),
      ],
    },
    {
      heading: t("stats.group.sections"),
      rows: [
        {
          key: "chapters-words",
          label: t("stats.row.chapters.words"),
          value: scopeValue(stats.sections.chapters),
          raw: stats.sections.chapters.words,
          detail: null,
          definition: t("stats.def.chapters.words", { excludes: EXCLUDES }),
        },
        {
          key: "front",
          label: t("stats.row.front"),
          value: scopeValue(stats.sections.front),
          raw: stats.sections.front.words,
          detail: scopeDetail(stats.sections.front, t("stats.absent.front")),
          definition: t("stats.def.front", { excludes: EXCLUDES }),
        },
        {
          key: "back",
          label: t("stats.row.back"),
          value: scopeValue(stats.sections.back),
          raw: stats.sections.back.words,
          detail: scopeDetail(stats.sections.back, t("stats.absent.back")),
          definition: t("stats.def.back", { excludes: EXCLUDES }),
        },
      ],
    },
    {
      heading: t("stats.group.structure"),
      rows: [
        {
          key: "parts",
          label: t("stats.row.parts"),
          value: formatNumber(stats.structure.parts),
          raw: stats.structure.parts,
          detail: null,
          definition: t("stats.def.parts", { excludes: EXCLUDES }),
        },
        {
          key: "chapters",
          label: t("stats.row.chapters"),
          value: formatNumber(stats.structure.chapters),
          raw: stats.structure.chapters,
          detail: null,
          definition: t("stats.def.chapters", { excludes: EXCLUDES }),
        },
        {
          key: "scenes",
          label: t("stats.row.scenes"),
          value: formatNumber(stats.structure.scenes),
          raw: stats.structure.scenes,
          detail: null,
          definition: t("stats.def.scenes", { excludes: EXCLUDES }),
        },
        {
          key: "longest",
          label: t("stats.row.longest"),
          value: words(stats.lengths.longest),
          raw: stats.lengths.longest,
          detail: null,
          definition: t("stats.def.longest", { excludes: EXCLUDES }),
        },
        {
          key: "shortest",
          label: t("stats.row.shortest"),
          value: words(stats.lengths.shortest),
          raw: stats.lengths.shortest,
          detail: null,
          definition: t("stats.def.shortest", { excludes: EXCLUDES }),
        },
        {
          key: "median",
          label: t("stats.row.median"),
          value: words(stats.lengths.median),
          raw: stats.lengths.median,
          detail: null,
          definition: t("stats.def.median", { excludes: EXCLUDES }),
        },
        {
          key: "empty",
          label: t("stats.row.empty"),
          value: formatNumber(stats.lengths.empty),
          raw: stats.lengths.empty,
          detail: null,
          definition: t("stats.def.empty"),
        },
        {
          key: "uncounted",
          label: t("stats.row.uncounted"),
          value: formatNumber(stats.lengths.uncounted),
          raw: stats.lengths.uncounted,
          detail: null,
          definition: t("stats.def.uncounted"),
        },
      ],
    },
    {
      heading: t("stats.group.states"),
      rows: [
        ...REVISION_STATES.map((state) => ({
          key: `state-${state}`,
          label: STATE_LABELS[state],
          value: formatNumber(stats.states.counts[state]),
          raw: stats.states.counts[state],
          detail: null,
          // A ZERO IS A REAL ANSWER HERE, unlike everywhere else in this panel:
          // "nothing is done yet" is a measurement, not an absence, so these
          // rows print 0 rather than the dash the word figures use.
          definition: t("stats.def.state", {
            state: STATE_LABELS[state].toLowerCase(),
            excludes: EXCLUDES_TREE,
          }),
        })),
        {
          key: "state-none",
          label: NO_STATE_LABEL,
          value: formatNumber(stats.states.none),
          raw: stats.states.none,
          detail: null,
          definition: t("stats.def.state.none", { excludes: EXCLUDES_TREE }),
        },
      ],
    },
    {
      heading: t("stats.group.session"),
      rows: [
        {
          key: "added",
          label: t("stats.row.added"),
          value: formatNumber(stats.session.added),
          raw: stats.session.added,
          detail: null,
          definition: t("stats.def.added"),
        },
        {
          key: "deleted",
          label: t("stats.row.deleted"),
          value: formatNumber(stats.session.deleted),
          raw: stats.session.deleted,
          detail: null,
          definition: t("stats.def.deleted"),
        },
        {
          key: "net",
          label: t("stats.row.net"),
          value: signed(stats.session.net),
          raw: stats.session.net,
          detail: null,
          definition: t("stats.def.net"),
        },
      ],
    },
    ...sourceWordGroups(stats.today.sources),
    {
      heading: t("stats.group.today"),
      rows: [writingTimeRow(stats.today)],
    },
  ];
}

/** The measurement's gaps, said beside every figure they affect: a total that
 *  silently skips paused saves reads as a complete one. */
function sourceGaps(summary: SourceWordSummary): string {
  const gaps: string[] = [];
  if (!summary.collecting) gaps.push(t("stats.sources.paused"));
  if (summary.interrupted) gaps.push(t("stats.sources.interrupted"));
  return gaps.map((gap) => " " + gap).join("");
}

function sourceWordGroups(summary: SourceWordSummary | undefined): StatGroup[] {
  if (summary === undefined) return [];
  const gaps = sourceGaps(summary);
  if (!summary.available) return [{
    heading: t("stats.group.sources"),
    rows: [{ key: "sources-unavailable", label: t("stats.sources.unavailable"), value: UNCOUNTED, raw: null,
      detail: t("stats.sources.unavailable.detail"), definition: t("stats.sources.definition") + gaps }],
  }];
  // The writer's own date and time (239), not an ISO stamp: this sentence is
  // read, and the export carries the same words beside the raw figures.
  // No start, no sentence: "Measurement started" needs a date after it.
  const since = summary.started_at === null
    ? ""
    : " " + t("stats.sources.since", { since: formatDateTime(summary.started_at) });
  const sources = ["typing", "pasted", "imported", "restored", "unattributed"] as const;
  const rows: StatRow[] = sources.filter((source) => source !== "unattributed" ||
    summary.totals[source].added !== 0 || summary.totals[source].deleted !== 0).map((source) => {
    const { added, deleted } = summary.totals[source];
    return {
      key: `source-${source}`, label: t(`stats.source.${source}`), value: signed(added - deleted), raw: added - deleted,
      detail: t("stats.sources.detail", { added: formatNumber(added), deleted: formatNumber(deleted) }),
      definition: t("stats.sources.definition") + since + gaps,
    };
  });
  rows.push({ key: "typing-today", label: t("stats.sources.today"),
    value: summary.today_typing === null ? UNCOUNTED : signed(summary.today_typing), raw: summary.today_typing,
    detail: null, definition: t("stats.sources.today.definition") + gaps });
  return [{ heading: t("stats.group.sources"), rows }];
}

/** One sentence-and-paragraph row. The rule travels with the
 *  figure, the same way the word rule does. */
function unitRow(
  key: string,
  unit: "sentences" | "paragraphs",
  units: Units | null,
  scope: "scene" | "chapter" | "part" | "manuscript",
  state: ScopeState,
): StatRow {
  const raw = units === null ? null : units[unit];
  return {
    key,
    label: t(`stats.row.${unit}.${scope}`),
    value: raw === null && state === "absent" ? NONE : words(raw),
    raw,
    detail: null,
    definition: t(`stats.def.${unit}.${scope}`, { excludes: EXCLUDES }),
  };
}

/** One row, three states: counted, switched off, unreadable. The definition
 *  changes with the state, because "12 min" beside a rule that says minutes
 *  are being counted would be a lie while they are not. */
function writingTimeRow(today: TodayFigures): StatRow {
  if (today.tracking === "off") {
    return {
      key: "writing-time",
      label: t("stats.row.writing-time"),
      value: today.writingMinutes === null ? t("stats.value.not-tracked") : formatMinutes(today.writingMinutes),
      raw: today.writingMinutes,
      detail: null,
      definition: t("stats.def.writing-time.off"),
    };
  }
  return {
    key: "writing-time",
    label: t("stats.row.writing-time"),
    value: today.writingMinutes === null ? UNCOUNTED : formatMinutes(today.writingMinutes),
    raw: today.writingMinutes,
    detail: null,
    definition: t("stats.def.writing-time"),
  };
}

/**
 * The rule every figure in the panel shares, said once at the bottom.
 *
 * SCOPE, EXCLUSIONS, TIMEZONE AND VERSION, which is what spec section 11 asks a
 * metric to expose. The timezone sentence is not filler: the bar's daily figure
 * DOES turn on the writer's local midnight, and a reader who knows that would
 * otherwise reasonably assume these figures do too.
 */
export const STATISTICS_NOTE = t("stats.note");

/** What the panel says instead of a table when there is nothing to measure.
 *  A manuscript with no scenes is a real state - an outline imported before any
 *  prose was written is exactly it - and painting it as a column of zeros claims
 *  measurements nobody made. */
export const STATISTICS_EMPTY = t("stats.empty");
