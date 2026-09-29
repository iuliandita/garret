import type { LibraryBook } from "./library";

export interface LibraryGroup { id: string; name: string }
export interface LibraryMembership { version: number; series: LibraryGroup | null; universe: LibraryGroup | null }
export type GroupEdit = { kind: "none" } | { kind: "existing"; id: string; name: string } | { kind: "new"; name: string };
export interface MembershipEdit { series: GroupEdit; universe: GroupEdit }
export interface MembershipView { generation: number; membership: LibraryMembership }
export interface SourceCount { added: number; deleted: number }
export interface SourceTotals {
  typing: SourceCount;
  pasted: SourceCount;
  imported: SourceCount;
  restored: SourceCount;
  unattributed: SourceCount;
}
export interface BookStats {
  identity_id: string | null;
  book_id: string | null;
  membership: LibraryMembership;
  words: number;
  unreadable_documents: number;
  documents: number;
  activity: SourceTotals | null;
  activity_interrupted: boolean;
  activity_warning: string | null;
  read_at_ms: number;
  took_ms: number;
}

export interface LibraryScope { identity: string | null; series: string | null; universe: string | null }

export function inScope(book: LibraryBook, scope: LibraryScope): boolean {
  return (scope.identity === null || book.identity_id === scope.identity)
    && (scope.series === null || book.series?.id === scope.series)
    && (scope.universe === null || book.universe?.id === scope.universe);
}

export function duplicateCopies(books: readonly LibraryBook[]): Map<string, LibraryBook[]> {
  const byId = new Map<string, LibraryBook[]>();
  for (const book of books) {
    if (book.error !== null || book.missing || book.book_id === null) continue;
    const copies = byId.get(book.book_id) ?? [];
    copies.push(book);
    byId.set(book.book_id, copies);
  }
  for (const [id, copies] of byId) if (copies.length < 2) byId.delete(id);
  return byId;
}

/** Every label snapshot stays visible. An ID conflict is not silently renamed. */
export function groupsOf(books: readonly LibraryBook[], kind: "series" | "universe"):
  { id: string; labels: string[]; sameNameId: boolean }[] {
  const byId = new Map<string, Set<string>>();
  for (const book of books) {
    if (book.error !== null || book.missing || book.membership_error !== null) continue;
    const group = book[kind];
    if (group === null) continue;
    const labels = byId.get(group.id) ?? new Set<string>();
    labels.add(group.name);
    byId.set(group.id, labels);
  }
  const nameCount = new Map<string, number>();
  for (const labels of byId.values()) for (const label of labels) nameCount.set(label, (nameCount.get(label) ?? 0) + 1);
  return [...byId].map(([id, labels]) => ({
    id, labels: [...labels].sort(), sameNameId: [...labels].some((label) => (nameCount.get(label) ?? 0) > 1),
  })).sort((a, b) => a.labels[0].localeCompare(b.labels[0]));
}

export interface SummarySelection {
  candidates: LibraryBook[];
  duplicateUnresolved: LibraryBook[][];
  missingUnknown: number;
  failedUnknown: number;
  membershipUnknown: number;
  outsideScope: number;
}

export function selectSummary(books: readonly LibraryBook[], scope: LibraryScope, representatives: ReadonlyMap<string, string>): SummarySelection {
  const duplicates = duplicateCopies(books);
  const candidates: LibraryBook[] = [];
  const duplicateUnresolved: LibraryBook[][] = [];
  let missingUnknown = 0;
  let failedUnknown = 0;
  let membershipUnknown = 0;
  let outsideScope = 0;
  for (const book of books) {
    if (book.missing) { missingUnknown++; continue; }
    if (book.error !== null) { failedUnknown++; continue; }
    if (book.book_id !== null && duplicates.has(book.book_id)) {
      const copies = duplicates.get(book.book_id)!;
      const chosen = representatives.get(book.book_id);
      if (chosen === undefined) {
        if (copies[0] === book) duplicateUnresolved.push(copies);
        continue;
      }
      if (book.path !== chosen) continue;
    }
    if (book.membership_error !== null) { membershipUnknown++; continue; }
    if (inScope(book, scope)) candidates.push(book);
    else outsideScope++;
  }
  return { candidates, duplicateUnresolved, missingUnknown, failedUnknown, membershipUnknown, outsideScope };
}
