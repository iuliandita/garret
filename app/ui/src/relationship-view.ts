import { formatNumber, plural, t } from "./i18n";

export interface RelationshipEndpoint { kind: string; id: string }
export interface RelationshipPoint extends RelationshipEndpoint { caption: string; available: boolean }
export interface RelationshipLink {
  id: string; source: RelationshipEndpoint; target: RelationshipEndpoint;
  source_caption: string; target_caption: string; source_available: boolean; target_available: boolean;
  label: string; note: string; citation: string;
  anchor: { quote: string } | null; anchor_stale: boolean;
}
export const relationshipKey = (point: RelationshipEndpoint): string => JSON.stringify([point.kind, point.id]);
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export function relationshipPoints(points: readonly RelationshipPoint[], links: readonly RelationshipLink[]): RelationshipPoint[] {
  const all = new Map(points.map((point) => [relationshipKey(point), point]));
  for (const link of links) for (const side of ["source", "target"] as const) {
    const endpoint = link[side]; const key = relationshipKey(endpoint);
    const previous = all.get(key);
    all.set(key, { ...endpoint, caption: previous?.caption ?? link[`${side}_caption`],
      available: (previous?.available ?? true) && link[`${side}_available`] });
  }
  return [...all.values()].sort((a, b) => compare(a.caption, b.caption) || compare(relationshipKey(a), relationshipKey(b)));
}

export function createRelationshipView(container: HTMLElement) {
  const doc = container.ownerDocument;
  const searchLabel = doc.createElement("label"); searchLabel.textContent = t("relationships.search");
  const search = doc.createElement("input"); search.type = "search"; search.id = "relationship-search"; searchLabel.append(search);
  const selectLabel = doc.createElement("label"); selectLabel.textContent = t("relationships.focus");
  const select = doc.createElement("select"); select.id = "relationship-focus"; selectLabel.append(select);
  const summary = doc.createElement("p"); summary.setAttribute("role", "status");
  const heading = doc.createElement("h3"); heading.tabIndex = -1;
  const diagram = doc.createElement("div"); diagram.className = "relationship-diagram";
  const list = doc.createElement("ol"); list.id = "relationship-list";
  const pageStatus = doc.createElement("p"); pageStatus.setAttribute("role", "status");
  const previous = doc.createElement("button"); previous.type = "button"; previous.textContent = t("relationships.previous");
  const next = doc.createElement("button"); next.type = "button"; next.textContent = t("relationships.next");
  container.append(searchLabel, selectLabel, heading, summary, diagram, list, pageStatus, previous, next);
  let points: RelationshipPoint[] = []; let links: readonly RelationshipLink[] = []; let selected = ""; let page = 0;
  let suffixes = new Map<string, string>();
  const caption = (point: RelationshipPoint, includeName = true): string => t("relationships.endpoint", {
    caption: includeName ? point.caption : "", kind: ["item", "cast", "resource"].includes(point.kind) ? t(`relationships.kind.${point.kind}`) : point.kind,
    distinction: suffixes.has(relationshipKey(point)) ? t("relationships.distinction", { id: suffixes.get(relationshipKey(point))! }) : "", state: point.available ? "" : t("relationships.missing"),
  });
  function options(): void {
    const query = search.value.toLocaleLowerCase();
    select.replaceChildren();
    for (const point of points) {
      const text = caption(point);
      if (query && relationshipKey(point) !== selected && ![text, point.id].some((value) => value.toLocaleLowerCase().includes(query))) continue;
      const option = doc.createElement("option"); option.value = relationshipKey(point); option.textContent = text; select.append(option);
    }
    select.value = selected;
  }
  function choose(key: string): void {
    selected = key; page = 0; search.value = ""; options(); render(); heading.focus();
  }
  /** THE FOCUS AND ITS NEIGHBOURS AS A TREE, drawn at the inspector's own
   *  width. The first version was a 580-unit drawing squeezed into
   *  328px: 9px text, connectors that stopped short of their captions and a
   *  numbering that matched nothing in the list. Now user units are pixels, so
   *  text is the panel's own 13/12px; every connector ends 6px before its
   *  caption, whose `dominant-baseline: middle` sits it on the line; and the
   *  direction is an arrowhead, so the drawing says at a glance what the list
   *  says row by row, plus the relationship's label under each name. */
  function drawDiagram(focus: RelationshipPoint, rows: readonly RelationshipLink[], shown: readonly RelationshipPoint[]): SVGSVGElement {
    const ns = "http://www.w3.org/2000/svg";
    const ROW = 36; const TOP = 12; const FIRST = TOP + 14; const TRUNK = 6; const BRANCH = 26; const TEXT = 32;
    const svg = doc.createElementNS(ns, "svg");
    svg.setAttribute("width", "100%"); svg.setAttribute("height", String(FIRST + shown.length * ROW + 4));
    svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
    const add = <K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] => {
      const node = doc.createElementNS(ns, name);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
      svg.append(node); return node;
    };
    const clip = (value: string, room: number): string => value.length > room ? value.slice(0, room - 1).trimEnd() + "\u2026" : value;
    const lastY = FIRST + shown.length * ROW - ROW / 2;
    add("path", { class: "relationship-trunk", d: ["M", TRUNK, TOP, "V", lastY].join(" ") });
    add("circle", { class: "relationship-hub", cx: TRUNK, cy: TOP, r: 4 });
    add("text", { class: "relationship-focus", x: TEXT - 12, y: TOP, "dominant-baseline": "middle" }).textContent = clip(focus.caption, 34);
    shown.forEach((neighbor, index) => {
      const key = relationshipKey(neighbor); const y = FIRST + index * ROW + ROW / 2;
      const incoming = rows.filter((link) => relationshipKey(link.source) === key && relationshipKey(link.target) === selected);
      const outgoing = rows.filter((link) => relationshipKey(link.target) === key && relationshipKey(link.source) === selected);
      add("path", { class: "relationship-edge", d: ["M", TRUNK, y, "H", BRANCH].join(" ") });
      if (outgoing.length) add("path", { class: "relationship-arrow", d: ["M", BRANCH - 4, y - 4, "L", BRANCH, y, "L", BRANCH - 4, y + 4].join(" ") });
      if (incoming.length) add("path", { class: "relationship-arrow", d: ["M", TRUNK + 4, y - 4, "L", TRUNK, y, "L", TRUNK + 4, y + 4].join(" ") });
      const name = add("text", { x: TEXT, y: y - 7, "dominant-baseline": "middle" });
      name.textContent = clip(neighbor.caption, 36);
      const title = doc.createElementNS(ns, "title"); title.textContent = caption(neighbor); name.append(title);
      const labels = [...new Set([...outgoing, ...incoming].map((link) => link.label.trim()).filter((label) => label !== ""))];
      const sub = [labels.join(", "), caption(neighbor, false).trim()].filter((part) => part !== "").join(" ");
      add("text", { class: "relationship-sub", x: TEXT, y: y + 9, "dominant-baseline": "middle" }).textContent = clip(sub, 44);
    });
    return svg;
  }
  function render(): void {
    list.replaceChildren(); diagram.replaceChildren();
    const focus = points.find((point) => relationshipKey(point) === selected);
    heading.textContent = focus ? caption(focus) : t("relationships.empty");
    const rows = links.filter((link) => relationshipKey(link.source) === selected || relationshipKey(link.target) === selected)
      .slice().sort((a, b) => compare(a.id, b.id));
    const keys = new Set(rows.map((link) => relationshipKey(relationshipKey(link.source) === selected ? link.target : link.source)));
    const neighbors = points.filter((point) => keys.has(relationshipKey(point)));
    summary.textContent = t("relationships.summary", {
      links: plural("relationships.count", rows.length, { count: formatNumber(rows.length) }),
      neighbors: plural("relationships.entries", neighbors.length, { count: formatNumber(neighbors.length) }),
    });
    if (neighbors.length > 20) summary.textContent = [summary.textContent, plural("relationships.omitted", neighbors.length - 20, { count: formatNumber(neighbors.length - 20) })].join(" ");
    if (focus && neighbors.length) diagram.append(drawDiagram(focus, rows, neighbors.slice(0, 20)));
    page = Math.min(page, Math.max(0, Math.ceil(rows.length / 20) - 1));
    for (const link of rows.slice(page * 20, (page + 1) * 20)) {
      const row = doc.createElement("li");
      const outgoing = relationshipKey(link.source) === selected;
      const point = points.find((point) => relationshipKey(point) === relationshipKey(outgoing ? link.target : link.source))!;
      const direction = doc.createElement("p"); direction.textContent = t(outgoing && relationshipKey(link.target) === selected ? "relationships.both" : outgoing ? "relationships.outgoing" : "relationships.incoming");
      const explore = doc.createElement("button"); explore.type = "button"; explore.textContent = caption(point);
      explore.addEventListener("click", () => choose(relationshipKey(point)));
      // Only the parts the writer filled in: "Note: ." is not a note.
      const detail = doc.createElement("p"); detail.textContent = ([["relationships.detail.label", link.label],
        ["relationships.detail.note", link.note], ["relationships.detail.citation", link.citation]] as const)
        .filter(([, value]) => value.trim() !== "").map(([key, value]) => t(key, { value })).join(" ");
      row.append(direction, explore, detail);
      if (link.anchor) {
        const quote = doc.createElement("p"); quote.className = "craft-saved-quote";
        quote.textContent = link.anchor.quote; row.append(quote);
      }
      if (link.anchor_stale) { const stale = doc.createElement("p"); stale.textContent = t("craft.anchor-stale"); row.append(stale); }
      list.append(row);
    }
    list.start = page * 20 + 1;
    pageStatus.textContent = t("relationships.page", { page: formatNumber(page + 1), pages: formatNumber(Math.max(1, Math.ceil(rows.length / 20))) });
    previous.disabled = page === 0; next.disabled = (page + 1) * 20 >= rows.length;
  }
  search.addEventListener("input", options);
  select.addEventListener("change", () => { if (select.value) choose(select.value); });
  previous.addEventListener("click", () => { page--; render(); heading.focus(); });
  next.addEventListener("click", () => { page++; render(); heading.focus(); });
  return {
    update(nextPoints: readonly RelationshipPoint[], nextLinks: readonly RelationshipLink[], preferred?: RelationshipEndpoint): void {
      links = nextLinks; points = relationshipPoints(nextPoints, links);
      const groups = new Map<string, RelationshipPoint[]>();
      for (const point of points) {
        const group = JSON.stringify([point.caption, point.kind]);
        const members = groups.get(group) ?? []; members.push(point); groups.set(group, members);
      }
      suffixes = new Map();
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        let length = 4;
        while (new Set(group.map((point) => point.id.slice(-length))).size < group.length) length++;
        for (const point of group) suffixes.set(relationshipKey(point), point.id.slice(-length));
      }
      if (!points.some((point) => relationshipKey(point) === selected)) {
        selected = preferred && points.some((point) => relationshipKey(point) === relationshipKey(preferred))
          ? relationshipKey(preferred) : points[0] ? relationshipKey(points[0]) : "";
        page = 0;
      }
      options(); render();
    },
  };
}
