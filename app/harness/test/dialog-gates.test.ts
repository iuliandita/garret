import { expect, test } from "bun:test";
import { evaluateDialogGates, type DialogMetrics } from "../src/gates";

const good: DialogMetrics = {
  dialog_opened: true,
  class_matches_while_open: 2,
  chosen_path: "/chosen/book.md",
  wrote_chosen_path: true,
  file_scenes: 2,
  store_scenes: 2,
  nonce_in_file: true,
  cancel_dialog_opened: true,
  cancel_files_written: 0,
  import_dialog_opened: true,
  library_projects_after_import: 1,
  imported_scenes: 2,
  folder_dialog_opened: true,
  folder_dialog_closed: true,
  folder_chosen_files: 1,
  folder_default_files: 0,
  folder_database_readable: true,
  folder_project_name: "A Book Chosen Here",
  folder_expected_name: "A Book Chosen Here",
  folder_starter_scenes: 1,
  folder_cancel_dialog_opened: true,
  folder_cancel_dialog_closed: true,
  folder_cancel_ready_again: true,
  folder_cancel_files: 0,
  peak_rss_mb: 100,
};

function verdict(metrics: DialogMetrics, gate: string): string {
  const found = evaluateDialogGates(metrics).find((v) => v.gate === gate);
  if (found === undefined) throw new Error(`missing ${gate}`);
  return found.verdict;
}

test("a complete native folder-dialog reading passes every added gate", () => {
  for (const gate of [
    "folder_dialog_opens",
    "folder_dialog_closes_after_choice",
    "folder_dialog_creates_in_the_chosen_directory",
    "folder_dialog_creates_a_readable_named_book",
    "folder_dialog_cancel_opens_and_closes",
    "folder_dialog_cancel_creates_nothing",
  ]) {
    expect(verdict(good, gate)).toBe("PASS");
  }
});

test("each native folder-dialog gate has a deliberate failing control", () => {
  const cases: [string, Partial<DialogMetrics>][] = [
    ["folder_dialog_opens", { folder_dialog_opened: false }],
    ["folder_dialog_closes_after_choice", { folder_dialog_opened: false }],
    ["folder_dialog_closes_after_choice", { folder_dialog_closed: false }],
    ["folder_dialog_creates_in_the_chosen_directory", { folder_dialog_opened: false }],
    ["folder_dialog_creates_in_the_chosen_directory", { folder_dialog_closed: false }],
    ["folder_dialog_creates_in_the_chosen_directory", { folder_chosen_files: 0 }],
    ["folder_dialog_creates_in_the_chosen_directory", { folder_chosen_files: 2 }],
    ["folder_dialog_creates_in_the_chosen_directory", { folder_default_files: 1 }],
    ["folder_dialog_creates_a_readable_named_book", { folder_database_readable: false }],
    ["folder_dialog_creates_a_readable_named_book", { folder_project_name: "Somewhere Else" }],
    ["folder_dialog_creates_a_readable_named_book", { folder_starter_scenes: 0 }],
    ["folder_dialog_creates_a_readable_named_book", { folder_starter_scenes: 2 }],
    ["folder_dialog_cancel_opens_and_closes", { folder_cancel_dialog_opened: false }],
    ["folder_dialog_cancel_opens_and_closes", { folder_cancel_dialog_closed: false }],
    ["folder_dialog_cancel_opens_and_closes", { folder_cancel_ready_again: false }],
    ["folder_dialog_cancel_creates_nothing", { folder_cancel_dialog_opened: false }],
    ["folder_dialog_cancel_creates_nothing", { folder_cancel_dialog_closed: false }],
    ["folder_dialog_cancel_creates_nothing", { folder_cancel_files: 1 }],
  ];
  for (const [gate, changed] of cases) {
    expect(verdict({ ...good, ...changed }, gate)).toBe("FAIL");
  }
});
