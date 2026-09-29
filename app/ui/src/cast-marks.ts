// app/ui/src/cast-marks.ts
// The cast, found in the open scene's own prose.
//
// A DECORATION, `comments.ts`'s own precedent: a ProseMirror plugin holding a
// DecorationSet that is MAPPED through every transaction rather than
// recomputed, because recomputing is the one thing this module must not do on
// the keystroke path. Nothing O(documents) or O(names x text) may run per
// keystroke, and a fresh walk of
// the document against every cast member's name on every typed character is
// exactly that shape -- the word-count rescan's own recorded cost.
//
// So the split is the same one comments.ts drew: `apply` MAPS on a document
// change (`DecorationSet.map`, cheap and exact) and only RECOMPUTES on an
// explicit signal -- a cast list arriving (`setMeta` with `names`) or a
// debounce timer firing 300 ms after the last edit (`setMeta` with
// `recompute`). The timer lives in the plugin's own `view()` spec, which is
// the one place a ProseMirror plugin is handed something to clean up on
// destroy, and is injectable so a test can fire it without a real clock.
import type { Node as PmNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

/** One name a cast member is found by, and the member it marks.
 *
 *  A LIST OF PAIRS RATHER THAN A MAP KEYED ON THE MEMBER, because the spec's
 *  "including aliases" is the second half of this feature: a member with
 *  two aliases is two pairs sharing an id, and the
 *  matcher below already treats every pair as independent text to look for.
 *  When aliases land as data this shape does not change. */
export interface CastNamePair {
  readonly text: string;
  readonly memberId: string;
}

/** The cast fields needed to expand a member's usable prose names. */
export interface CastNameMember {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
}

/** The canonical names, explicit aliases, and unambiguous first and last name
 * parts for a cast list. Multiword canonical names and explicit aliases always
 * remain usable; every bare token is omitted when another member could own it. */
export function castNamesFor(list: readonly CastNameMember[]): CastNamePair[] {
  const names: CastNamePair[] = [];
  const seen = new Set<string>();
  const explicitAliases = new Set<string>();
  const tokenOwners = new Map<string, Set<string>>();

  const add = (text: string, memberId: string): void => {
    const key = `${memberId}\u0000${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    names.push({ text, memberId });
  };
  const addTokenOwner = (token: string, memberId: string): void => {
    const owners = tokenOwners.get(token) ?? new Set<string>();
    owners.add(memberId);
    tokenOwners.set(token, owners);
  };

  for (const member of list) {
    const parts = member.name.trim().split(/\p{White_Space}+/u);
    if (parts.length > 1) add(member.name, member.id);
    for (const alias of member.aliases) {
      add(alias, member.id);
      explicitAliases.add(alias);
    }
    addTokenOwner(parts[0] ?? "", member.id);
    if (parts.length > 1) addTokenOwner(parts[parts.length - 1] ?? "", member.id);
  }

  for (const member of list) {
    const parts = member.name.trim().split(/\p{White_Space}+/u);
    for (const part of parts.length === 1 ? [parts[0]] : [parts[0], parts[parts.length - 1]]) {
      if (part === undefined) continue;
      if (explicitAliases.has(part)) continue;
      if (tokenOwners.get(part)?.size !== 1) continue;
      add(part, member.id);
    }
  }
  return names;
}

/** Below this length a "name" is too likely to be an ordinary word ("Al", "Jo")
 *  to mark every occurrence of it in a manuscript's prose. */
export const MIN_CAST_NAME_LENGTH = 3;

/** How long after the last document change a debounced recompute runs. */
export const CAST_MARKS_DEBOUNCE_MS = 300;

/** The class the stylesheet marks a cast member's name with. */
export const CAST_MARK_CLASS = "cast-mark";

const WORD_CHAR = /\p{L}/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/** Whether `text[at .. at+needle.length)` is `needle`, bounded by a
 *  non-letter (or the end of `text`) on both sides. Case-sensitive, per the
 *  design record: a cast member's name is a proper noun, and matching its
 *  lowercase form would mark ordinary words that merely share a spelling. */
function wholeWordAt(text: string, at: number, needle: string): boolean {
  if (text.startsWith(needle, at) === false) return false;
  if (isWordChar(text[at - 1])) return false;
  if (isWordChar(text[at + needle.length])) return false;
  return true;
}

export interface CastMarkRange {
  readonly from: number;
  readonly to: number;
  readonly memberId: string;
}

/** Every non-overlapping match of `names` in `text`, longest name first at
 *  each position so "Maestro Kell" wins over "Kell" rather than the other way
 *  round, and a name under `MIN_CAST_NAME_LENGTH` is never looked for.
 *
 *  PURE AND POSITION-LOCAL: `text` is one ProseMirror text node's own string
 *  and the returned ranges are offsets INTO IT, not document positions --
 *  `buildCastDecorations` below adds the node's own start. Exported and
 *  tested at this level because a Decoration and a DecorationSet are not
 *  things a test can read a match back out of usefully, `comments.ts`'s own
 *  reason for keeping `mapAnchors` free of the view. */
export function matchesInText(
  text: string,
  names: readonly CastNamePair[],
): readonly { from: number; to: number; memberId: string }[] {
  const usable = names
    .filter((n) => n.text.length >= MIN_CAST_NAME_LENGTH)
    .slice()
    // LONGEST FIRST, and for two names of the SAME length -- two different
    // cast members who happen to share a name, or an alias identical to
    // another member's own name -- `localeCompare` rather than whatever
    // order they arrived in. `Array.prototype.sort` is stable, so leaving the
    // comparator at length alone let input order decide a real tie with
    // nothing recording that it had, and reordering the input would silently
    // change which member's mark a shared name gets. A THIRD KEY on the
    // member id settles the one case `localeCompare` on the text cannot: two
    // members who share the identical name.
    .sort(
      (a, b) =>
        b.text.length - a.text.length ||
        a.text.localeCompare(b.text) ||
        a.memberId.localeCompare(b.memberId),
    );
  if (usable.length === 0) return [];
  const out: { from: number; to: number; memberId: string }[] = [];
  let i = 0;
  while (i < text.length) {
    const hit = usable.find((n) => wholeWordAt(text, i, n.text));
    if (hit === undefined) {
      i += 1;
      continue;
    }
    out.push({ from: i, to: i + hit.text.length, memberId: hit.memberId });
    i += hit.text.length;
  }
  return out;
}

/** Every match in the whole document, in document order, as ProseMirror
 *  positions. One walk of the document's TEXTBLOCKS, `MAX_MAPPED_COMMENTS`'s
 *  own reasoning applied to a different ceiling: this runs once per debounce
 *  or per cast change, never per keystroke.
 *
 *  PER TEXTBLOCK, NOT PER TEXT NODE. A mark boundary splits a paragraph's
 *  content into several sibling text nodes with no text of their own beyond
 *  their own run, and matching each in isolation defeats the whole-word
 *  check both ways: "**Kell**ner" (a bold "Kell" followed by a plain "ner")
 *  matched "Kell" as a whole word, because the node holding "Kell" has
 *  nothing after it to see "ner" with; and "Maestro *Kell*" (an italic
 *  "Kell" alone) could never find the longer name "Maestro Kell" at all,
 *  because no single node's own text ever contains both words when a mark
 *  splits between them. Concatenating each textblock's own inline text
 *  first, and mapping the match positions found in it back through the
 *  positions its own child text nodes actually occupy, answers both: the
 *  schema here allows only text as inline content (`content: "text*"`), so
 *  every unit of a block's own text is a text node with a known length and
 *  nothing else to account for. */
export function matchesInDoc(doc: PmNode, names: readonly CastNamePair[]): readonly CastMarkRange[] {
  if (names.length === 0) return [];
  const out: CastMarkRange[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = "";
    node.forEach((child) => {
      if (child.isText) text += child.text ?? "";
    });
    // The textblock's own content starts one position past its opening
    // token -- `pos` here is the position of that token, matching the
    // reasoning `matchesInDoc`'s own test spells out for a second paragraph.
    const contentStart = pos + 1;
    for (const m of matchesInText(text, names)) {
      out.push({ from: contentStart + m.from, to: contentStart + m.to, memberId: m.memberId });
    }
    return false;
  });
  return out;
}

function buildCastDecorations(doc: PmNode, names: readonly CastNamePair[]): DecorationSet {
  const matches = matchesInDoc(doc, names);
  const decorations = matches.map((m) =>
    Decoration.inline(m.from, m.to, {
      class: CAST_MARK_CLASS,
      "data-member-id": m.memberId,
    }),
  );
  return DecorationSet.create(doc, decorations);
}

export interface CastMarksPluginState {
  readonly names: readonly CastNamePair[];
  readonly decorations: DecorationSet;
}

export const castMarksKey = new PluginKey<CastMarksPluginState>("cast-marks");

type CastMarksMeta = { readonly names: readonly CastNamePair[] } | { readonly recompute: true };

export interface CastMarksPluginOptions {
  debounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** The plugin `editor.ts` installs beside `commentsPlugin()`. See the module
 *  header for why `apply` maps instead of recomputing. */
export function castMarksPlugin(opts: CastMarksPluginOptions = {}): Plugin<CastMarksPluginState> {
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => window.setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((handle: unknown) => window.clearTimeout(handle as number));
  const debounceMs = opts.debounceMs ?? CAST_MARKS_DEBOUNCE_MS;

  return new Plugin<CastMarksPluginState>({
    key: castMarksKey,
    state: {
      init: (_config, state) => ({ names: [], decorations: buildCastDecorations(state.doc, []) }),
      apply(tr, value, _old, next) {
        const meta = tr.getMeta(castMarksKey) as CastMarksMeta | undefined;
        if (meta !== undefined && "names" in meta) {
          // A FRESH LIST. Nothing is mapped: it describes the document as it
          // now is, the same rule commentsPlugin's own replacement branch
          // follows for the identical reason.
          return { names: meta.names, decorations: buildCastDecorations(next.doc, meta.names) };
        }
        if (meta !== undefined && "recompute" in meta) {
          // THE DEBOUNCE FIRING. Same names, a fresh walk of the document
          // that has settled since the last one.
          return { names: value.names, decorations: buildCastDecorations(next.doc, value.names) };
        }
        if (!tr.docChanged) return value;
        if (value.names.length === 0) return value;
        // MAPPED, NOT RECOMPUTED -- the whole point of this module. An
        // insertion before a mark keeps the mark on the same text; the
        // debounce above is what catches a new name typed into the prose.
        return { names: value.names, decorations: value.decorations.map(tr.mapping, next.doc) };
      },
    },
    props: {
      decorations: (state) => castMarksKey.getState(state)?.decorations,
    },
    view() {
      let timer: unknown = null;
      return {
        update(view, prevState) {
          if (view.state.doc === prevState.doc) return;
          // NOTHING TO RECOMPUTE WITH NO NAMES -- the preference off, or a
          // book with no cast yet. Without this guard every keystroke in
          // every scene arms a 300ms timer that fires a no-op dispatch, and
          // that dispatch is a real transaction: it re-arms the format
          // bubble's own rest debounce for a scene the writer never asked
          // this plugin to look at.
          if (castMarksKey.getState(view.state)?.names.length === 0) return;
          // COALESCED: a burst of keystrokes re-arms the same timer rather
          // than queuing one recompute per character.
          if (timer !== null) clearTimer(timer);
          timer = setTimer(() => {
            timer = null;
            view.dispatch(view.state.tr.setMeta(castMarksKey, { recompute: true }));
          }, debounceMs);
        },
        destroy() {
          if (timer !== null) {
            clearTimer(timer);
            timer = null;
          }
        },
      };
    },
  });
}
