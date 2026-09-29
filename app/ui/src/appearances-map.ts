// app/ui/src/appearances-map.ts
// Who appears where, across the whole book.
//
// THE CAST PANEL'S SHAPE, NOT THE SYNOPSIS PANEL'S. It reads no navigator
// selection at all, because -- in the cast panel's own words -- this is not
// about the row the writer is on, it is about the BOOK. There is nothing here
// to capture and nothing to be wrong about.
//
// THE ROLLUP IS DERIVED ON READ, HERE, EVERY TIME IT OPENS. Nothing is stored
// per container: see `appearances.ts` and the design record. The walk is handed
// in by the caller, freshly, exactly as `refreshCounts` hands one to
// `rollUpCounts`.
//
// ONLY ROWS SOMEBODY APPEARS IN ARE LISTED. Two reasons, and the first is the
// product one: the panel answers "who appears where", and a scene nobody has
// been placed in has no answer to give -- printing every row of a manuscript
// would bury the ones that do, which is `formatCount`'s "an absent count
// renders as NOTHING" rule one level up. The second is that it bounds this
// panel's DOM by what the writer has actually said rather than by the size of
// their book, so there is no virtual list here and no reason for one.
//
// TWO LISTS PER ROW AND THEY ARE DISJOINT. "Here" is what the writer tagged on
// this row itself; "Further down" is the rest of the union, which arrived from
// the scenes underneath. A container's list that did not say which was which
// would leave a writer unable to explain why a name is on a chapter -- and the
// two behave differently: a direct tag stays when the scenes move, a derived
// one does not.
//
// EACH OF THOSE TWO IS ITSELF ONE LINE PER KIND THAT HAS ANYBODY IN IT. A
// "Here" line naming Meddow and Ines Varo in one breath read the two
// as the same kind of thing -- a character and a place -- so `paintBucket`
// calls `line` once per `CAST_KINDS` entry that is non-empty, glyph first, in
// the order the cast and tagging panels already use. THE VISIBLE "Here:" OR
// "Further down:" IS SAID ONCE PER BUCKET, on its first line only --
// repeating the same word on every kind read as three
// separate claims about one row -- and every line's `aria-label` names its
// own kind and bucket regardless, because a reader who cannot see which line
// is indented under the label has no other way to know.
import { t } from "./i18n";
import { createPanelShell } from "./panel-shell";
import { appearancesForBook, type ItemAppearances } from "./appearances";
import { CAST_KINDS, groupKeyFor, kindIconFor } from "./cast-kinds";
import { createIcon } from "./icons";
import type { CastMemberRow } from "./cast-panel";
import type { ProjectItem } from "./store/source";

export interface AppearancesMapDeps {
  /** The bar anchor from index.html. Positioned absolutely against
   *  #project-bar, so it contributes nothing to the strip's line box. */
  readonly container: HTMLElement;
  /** The LIVE walk, read at the moment the panel opens. Handed in rather than
   *  fetched, exactly as `refreshCounts` is handed one: the page already holds
   *  it and a second read would be a second answer to disagree with the
   *  navigator about. */
  items(): readonly ProjectItem[];
  cast(): Promise<CastMemberRow[]>;
  /** Every tag in the project, by item id. ONE call for the whole book. */
  read(): Promise<ItemAppearances>;
  onNotice(message: string): void;
  /** Where focus goes when the panel is dismissed with Escape. Not called for
   *  an outside click: a click already says where the writer wants to be. */
  onDismiss(): void;
}

export interface AppearancesMap {
  open(): Promise<void>;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

export function createAppearancesMap(deps: AppearancesMapDeps): AppearancesMap {
  const { container } = deps;

  const panel = document.createElement("div");
  panel.id = "appears-map-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", t("appears.map.panel.label"));
  panel.tabIndex = -1;
  panel.hidden = true;

  const scope = document.createElement("p");
  scope.id = "appears-map-scope";
  scope.textContent = t("appears.map.scope");

  const status = document.createElement("div");
  status.id = "appears-map-status";
  status.setAttribute("role", "status");

  const rows = document.createElement("div");
  rows.id = "appears-map-rows";
  rows.setAttribute("role", "group");
  rows.setAttribute("aria-label", t("appears.map.list.label"));

  // THE OTHER DIRECTION. The rows above answer "who is here"; this answers
  // "where does Ada appear", which is the question `appearance_by_member` was
  // indexed for and nothing read until 2026-09-01. Derived on the page from the
  // same one read, so the two lists cannot disagree.
  const members = document.createElement("div");
  members.id = "appears-map-members";
  members.setAttribute("role", "group");
  members.setAttribute("aria-label", t("appears.map.members.label"));

  panel.append(scope, status, rows, members);
  container.append(panel);

  let destroyed = false;
  /** An answer that resolves after a newer open, or after the panel closed,
   *  must not repaint: the writer would be shown a book they are no longer
   *  looking at. */
  let generation = 0;

  function setOpen(open: boolean): void {
    panel.hidden = !open;
  }

  function close(): void {
    generation += 1;
    rows.replaceChildren();
    members.replaceChildren();
    status.textContent = "";
    setOpen(false);
  }

  /** One line per cast member: the titles of the rows they are tagged on
   *  DIRECTLY, in walk order, or a sentence saying nowhere. Direct tags only --
   *  a derived presence on a chapter is a fact about the chapter, and listing
   *  it here would print every ancestor of every scene. Members are sorted the
   *  way the cast panel sorts them, by name in the writer's locale. */
  function paintMembers(
    items: readonly ProjectItem[],
    cast: readonly CastMemberRow[],
    perItem: ItemAppearances,
    inBook: ReadonlySet<string>,
  ): void {
    members.replaceChildren();
    const titlesOf = new Map<string, string[]>();
    for (const item of items) {
      if (!inBook.has(item.id)) continue;
      for (const id of perItem[item.id] ?? []) {
        const list = titlesOf.get(id);
        if (list === undefined) titlesOf.set(id, [item.title]);
        else list.push(item.title);
      }
    }
    const heading3 = document.createElement("h3");
    heading3.className = "appears-map-members-heading";
    heading3.textContent = t("appears.map.members.heading");
    members.append(heading3);
    const sorted = [...cast].sort((x, y) => x.name.localeCompare(y.name));
    for (const member of sorted) {
      const p = document.createElement("p");
      p.className = "appears-map-member";
      p.dataset.memberId = member.id;
      const titles = titlesOf.get(member.id);
      p.textContent =
        titles === undefined
          ? t("appears.map.member.nowhere", { name: member.name })
          : t("appears.map.member.in", { name: member.name, titles: titles.join(", ") });
      members.append(p);
    }
  }

  /** The sentence for one row's names IN ONE KIND. A row's "Here" or
   *  "Further down" used to be a single line
   *  naming everybody regardless of kind, which read Meddow and Ines Varo --
   *  a place and a character -- as the same kind of thing; this is one such
   *  line PER KIND that has anybody in it, so the glyph tells them apart the
   *  way the cast panel's own list already does.
   *
   *  THE LABEL IS SAID ONCE PER BUCKET, not once per line: `showLabel` is
   *  true only for the first kind a bucket has anybody in, so a row with
   *  Ada, a character, AND The harbour, a place, both "Here" reads "Here:
   *  Ada" then an indented line naming the harbour alone -- not "Here: Ada"
   *  followed by a second "Here: The harbour" repeating a word the reader
   *  already has. `[data-continued]` is what the stylesheet indents on.
   *
   *  THE ACCESSIBLE NAME SAYS ITS OWN KIND AND BUCKET REGARDLESS, because a
   *  screen reader has no indentation to infer the omitted label from: an
   *  `aria-label` built from `ariaKey`, the kind's own plural name (the cast
   *  panel's `cast.group.<kind>` catalog key, restated rather than repeated
   *  so the two lists cannot name a kind two different ways) and the same
   *  names the visible text carries. */
  function line(
    key: string,
    ariaKey: string,
    className: string,
    kind: string,
    named: string[],
    showLabel: boolean,
  ): HTMLElement {
    const p = document.createElement("p");
    p.className = className;
    p.dataset.kind = kind;
    if (!showLabel) p.dataset.continued = "true";
    // DECORATIVE, `aria-hidden` (the cast panel's own belt-and-braces
    // reason): the line's accessible text is the `aria-label` below and
    // nothing else, so a reader who cannot see the glyph loses nothing a
    // sighted one has -- the KIND is not information carried nowhere else,
    // it is a visual sort the visible text does not always restate.
    const iconName = kindIconFor(kind);
    if (iconName !== null) {
      const icon = document.createElement("span");
      icon.className = "appears-map-line-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.append(createIcon(iconName));
      p.append(icon);
    }
    // JOINED WITH A COMMA AND A SPACE rather than rendered as a list of
    // elements: these are names in a sentence the catalog owns, and a
    // per-name element would put the separator in the code where no
    // translation can reach it.
    const names = named.join(", ");
    p.append(document.createTextNode(showLabel ? t(key, { names }) : names));
    const groupKey = groupKeyFor(kind);
    const kindLabel = groupKey === null ? kind : t(groupKey);
    p.setAttribute("aria-label", t(ariaKey, { kind: kindLabel, names }));
    return p;
  }

  /** One bucket ("Here" or "Further down"), one line per kind it has anybody
   *  in, CHARACTER BEFORE PLACE BEFORE POINT OF INTEREST -- `CAST_KINDS`'s
   *  own order, the same order the cast panel and the tagging panel already
   *  group by. Only the FIRST line painted carries the visible label. */
  function paintBucket(
    row: HTMLElement,
    key: string,
    ariaKey: string,
    className: string,
    byKind: ReadonlyMap<string, string[]>,
  ): void {
    let first = true;
    for (const kind of CAST_KINDS) {
      const named = byKind.get(kind);
      if (named === undefined || named.length === 0) continue;
      row.append(line(key, ariaKey, className, kind, named, first));
      first = false;
    }
  }

  function paint(
    items: readonly ProjectItem[],
    members_: readonly CastMemberRow[],
    perItem: ItemAppearances,
  ): void {
    rows.replaceChildren();
    members.replaceChildren();
    // CLEARED FIRST AND NOT LAST, and a capture is what settled it. The line
    // that clears it used to sit after the row loop, and the empty-cast branch
    // below RETURNS before reaching it -- so a book with no cast painted
    // "Reading the book..." above a sentence saying the book has nobody in it,
    // which is two answers to one question with the stale one on top.
    // Thirteenth defect found by looking.
    status.textContent = "";
    if (members_.length === 0) {
      // THE FIRST EMPTY STATE, and it is a different one from the second. There
      // is nobody to place, so the route out is the cast panel.
      const empty = document.createElement("p");
      empty.className = "appears-map-empty";
      empty.textContent = t("appears.map.empty-cast");
      rows.append(empty);
      return;
    }
    const nameOf = new Map(members_.map((m) => [m.id, m.name] as const));
    const kindOf = new Map(members_.map((m) => [m.id, m.kind] as const));
    const totals = appearancesForBook(items, perItem);
    let painted = 0;
    for (const item of items) {
      const union = totals.get(item.id);
      // An item outside the book has no entry at all. An item nobody appears
      // in has an EMPTY one, and it is dropped a few lines below by the
      // here/below check rather than here: `union.size === 0` implies both of
      // those lists are empty, so a second refusal of the same input is one no
      // input can tell from its absence -- a mutation deleting it survived the
      // whole suite, which is how that was found. Two rules refusing one input
      // cover for each other; this file keeps the one that ALSO refuses a union
      // of members the cast list cannot name.
      if (union === undefined) continue;
      const own = new Set(perItem[item.id] ?? []);
      // NAMED, and a member this build cannot name is DROPPED rather than
      // printed as a raw id: an id is not a description of anybody, and a row
      // naming one would send a writer looking for a character called
      // `01a046f9-...`. It can only happen when the two reads disagree, which
      // is a member deleted between them.
      //
      // GROUPED BY KIND, not one flat list: `CAST_KINDS`
      // is the panel-wide order a writer already reads in the cast and the
      // tagging panel, and `kindOf` comes from the same `members_` read as
      // `nameOf` so the two can never disagree about who is what kind.
      const hereByKind = new Map<string, string[]>();
      const belowByKind = new Map<string, string[]>();
      for (const id of union) {
        const named = nameOf.get(id);
        const kind = kindOf.get(id);
        if (named === undefined || kind === undefined) continue;
        const bucket = own.has(id) ? hereByKind : belowByKind;
        const named_ = bucket.get(kind);
        if (named_ === undefined) bucket.set(kind, [named]);
        else named_.push(named);
      }
      if (hereByKind.size === 0 && belowByKind.size === 0) continue;
      // THE WRITER'S OWN LOCALE, `paintMembers`'s own rule: a plain
      // `.sort()` orders by UTF-16 code unit, which puts every
      // capital before every lowercase letter and reads "Zoe, ada" as
      // alphabetical to nobody.
      for (const names of hereByKind.values()) names.sort((x, y) => x.localeCompare(y));
      for (const names of belowByKind.values()) names.sort((x, y) => x.localeCompare(y));
      const row = document.createElement("div");
      row.className = "appears-map-row";
      row.dataset.id = item.id;
      row.dataset.type = item.type;
      // The walk's own depth, painted as an attribute the stylesheet indents
      // on -- never derived from anything here. `data-indent` is the
      // navigator's name for the same fact and this restates the convention
      // rather than the depth.
      row.dataset.indent = String(Math.min(item.depth, 6));
      const title = document.createElement("h3");
      title.className = "appears-map-title";
      title.textContent = item.title;
      row.append(title);
      // HERE BEFORE FURTHER DOWN, one line per kind that has anybody in it --
      // the single combined line each used to be, now split, and the label
      // said once per bucket rather than once per line (review ticket 08).
      paintBucket(row, "appears.map.here", "appears.map.aria.here", "appears-map-here", hereByKind);
      paintBucket(row, "appears.map.below", "appears.map.aria.below", "appears-map-below", belowByKind);
      rows.append(row);
      painted += 1;
    }
    if (painted === 0) {
      // THE SECOND EMPTY STATE. The book HAS a cast and nobody has been placed
      // in it, so the route out is the tagging panel and not the cast panel.
      // One sentence for both states would send a writer to the wrong surface
      // in one case out of two. No by-member list under it: every line would
      // say "nowhere", which the sentence above already says once.
      const empty = document.createElement("p");
      empty.className = "appears-map-empty";
      empty.textContent = t("appears.map.empty");
      rows.append(empty);
      return;
    }
    paintMembers(items, members_, perItem, new Set(totals.keys()));
  }

  // Close, Escape and a click elsewhere (the shell's).
  const shell = createPanelShell({
    panel,
    title: t("appears.map.heading"),
    titleId: "appears-map-heading",
    close,
    returnFocus: deps.onDismiss,
    inspector: true,
  });

  return {
    async open(): Promise<void> {
      generation += 1;
      const mine = generation;
      // Painted BEFORE the reads resolve, so the panel says what it is from the
      // moment it appears rather than after a round trip.
      status.textContent = t("appears.map.reading");
      rows.replaceChildren();
      setOpen(true);
      panel.focus();
      // THE WALK IS READ HERE, not at construction and not held: an outline
      // edited with the panel closed must be the outline the panel shows the
      // next time it opens.
      const walk = deps.items();
      let members: CastMemberRow[];
      let perItem: ItemAppearances;
      try {
        [members, perItem] = await Promise.all([deps.cast(), deps.read()]);
      } catch (err) {
        if (destroyed || mine !== generation) return;
        // NOT either designed empty state, for the recorded `renderImports([])`
        // reason: a store this panel could not read must not be reported as a
        // book nobody has been placed in.
        rows.replaceChildren();
        status.textContent = "";
        deps.onNotice(t("appears.map.error.read", { error: String(err) }));
        return;
      }
      if (destroyed || mine !== generation) return;
      paint(walk, members, perItem);
    },
    close,
    isOpen(): boolean {
      return !panel.hidden;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      shell.destroy();
      panel.remove();
    },
  };
}
