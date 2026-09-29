import type { ReviewHunk } from "./review-fragments";

export interface ReviewAuthor { id: number; display_name: string; created_at: number }
export interface ReviewMessage { id: number; group_id: number; author_id: number; author_name: string; body: string; created_at: number }
export interface StoredReviewHunk {
  id: number; original: ReviewHunk; mapped_from: number; mapped_to: number;
  state: string; conflicted_at: number | null; decided_at: number | null;
  decision_author_id: number | null; decision_author_name: string | null;
}
export interface ReviewGroup {
  id: number; item_id: string; author_id: number; author_name: string;
  rev: number; created_at: number; hunks: StoredReviewHunk[];
}
export interface ReviewSummary {
  id: number; author_name: string; rev: number; created_at: number;
  pending: number; conflicted: number; accepted: number; rejected: number; messages: number;
}
export interface ReviewPage { groups: ReviewSummary[]; before_id: number | null }
export interface ReviewState {
  document: { item_id: string; body: string; rev: number };
  authors: ReviewAuthor[];
  page: ReviewPage;
}
export type ReviewDecision = "accept" | "reject";
