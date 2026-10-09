#!/usr/bin/env python3
"""Exercise the real offline docs CLI in disposable Git repositories."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

GUARD = Path(__file__).with_name("check-docs.py").resolve()
HOST = "app/shell-tauri/src-tauri/src/"
NOTE = "The editor selection behavior is unchanged for manuscript writers."
MIGRATION = "Previous books remain compatible. Back up the closed book before upgrade; open it with the new version. To roll back, restore the backup with the previous version."


class DocsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "repo"
        self.root.mkdir()
        self.git("init", "-q")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Test")
        self.write("scripts/check-docs.py", GUARD.read_text())
        for path in ("README.md", "docs/MAINTENANCE.md", "docs/COMPATIBILITY.md", "docs/RELEASES.md", "docs/screenshots/manifest.json"):
            self.write(path, "Initial documentation.\n")
        self.write("app/ui/src/editor.ts", "export const editor = 1;\n")
        self.write(HOST + "store/mod.rs", "const SCHEMA_VERSION: u32 = 17;\nfn query() { select(); }\n")
        self.write(HOST + "data_migration.rs", 'const LEGACY_DIR: &str = "old";\nfn prepare_copy() { old(); }\n')
        self.write(HOST + "package_format.rs", "const VERSION: u16 = 20;\n")
        self.commit("initial")
        self.cli("--init", "--note", "Explicit source baseline only; documentation correctness remains independently reviewed.")
        self.commit("baseline")
        self.git("tag", "base")

    def git(self, *args, cwd=None, expected=0):
        result = subprocess.run(["git", *args], cwd=cwd or self.root, text=True, capture_output=True)
        self.assertEqual(result.returncode, expected, result.stderr)
        return result.stdout.strip()

    def write(self, path, content):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def commit(self, message):
        self.git("add", ".")
        self.git("commit", "-qm", message)

    def cli(self, *args, ok=True, contains=None, cwd=None):
        result = subprocess.run([sys.executable, str(self.root / "scripts/check-docs.py"), *args], cwd=cwd or self.root, text=True, capture_output=True)
        self.assertEqual(result.returncode == 0, ok, result.stdout + result.stderr)
        if contains:
            self.assertIn(contains, result.stdout + result.stderr)
        return result

    def accept(self, domain="editor", docs=None, **kwargs):
        args = ["--base", "base", "--accept", domain]
        if docs:
            args += ["--docs", docs, "--note", NOTE]
        else:
            args += ["--no-impact", NOTE]
        for key, value in kwargs.items():
            args += ["--" + key.replace("_", "-"), value]
        return self.cli(*args)

    def test_baseline_and_specific_reasons(self):
        self.cli()
        self.cli("--init", "--note", NOTE, ok=False, contains="already exists")
        self.cli("--accept", "editor", "--no-impact", "no docs impact", ok=False, contains="specific explanation")
        self.cli("--accept", "editor", "--no-impact", "Documentation is up to date", ok=False, contains="generic waiver")

    def test_source_and_cited_docs_staleness(self):
        self.write("app/ui/src/editor.ts", "export const editor = 2;\n")
        self.cli("--base", "base", ok=False, contains="source changed")
        self.write("README.md", "Selection behavior now documented.\n")
        self.accept(docs="README.md")
        self.cli("--base", "base")
        self.write("README.md", "A later edit invalidates the cited bytes.\n")
        self.cli("--base", "base", ok=False, contains="stale or missing cited")
        self.accept(docs="README.md")
        self.write("app/ui/src/editor.ts", "export const editor = 3;\n")
        self.cli("--base", "base", ok=False, contains="stale source")

    def test_unchanged_and_unrelated_citations(self):
        self.write("app/ui/src/editor.ts", "changed();\n")
        self.cli("--base", "base", "--accept", "editor", "--docs", "README.md", "--note", NOTE, ok=False, contains="has not changed")
        self.write("docs/RELEASES.md", "Updated release instructions.\n")
        self.cli("--base", "base", "--accept", "editor", "--docs", "docs/RELEASES.md", "--note", NOTE, ok=False, contains="allowed tracked")
        self.cli("--base", "base", "--accept", "editor", "--docs", "docs/docs-impact.json", "--note", NOTE, ok=False, contains="allowed tracked")

    def test_staged_new_sources_and_exclusions(self):
        self.write("app/ui/src/new.ts", "newRuntime();\n")
        self.cli("--base", "base")  # Untracked scratch is intentionally ignored.
        self.git("add", "app/ui/src/new.ts")
        self.cli("--base", "base", ok=False, contains="source changed")
        self.accept()
        for path in ("lab/new.ts", "app/ui/test/new.test.ts", "app/results/output.json", "app/ui/src/fixtures/input.ts", "docs/local/private.md", "scripts/test-new.py"):
            self.write(path, "Excluded fixture or private text.\n")
        self.git("add", ".")
        self.cli("--base", "base")
        self.write("scripts/test-docs.py", "Documentation guard infrastructure check.\n")
        self.git("add", "scripts/test-docs.py")
        self.cli("--base", "base", ok=False, contains="maintenance: source changed")
        self.accept("maintenance")
        self.cli("--base", "base")

    def test_rename_and_deletion_change_digest(self):
        self.git("mv", "app/ui/src/editor.ts", "app/ui/src/renamed.ts")
        self.cli("--base", "base", ok=False, contains="source changed")
        self.accept()
        self.cli("--base", "base")
        self.git("rm", "-f", "app/ui/src/renamed.ts")
        self.cli("--base", "base", ok=False, contains="stale source")
        self.accept()
        self.cli("--base", "base")
        self.commit("remove editor")
        self.cli("--base", "base")  # Receipt is stable across committing deletions.

    def test_receipt_replay_and_baseline_reset_do_not_waive_range(self):
        original = (self.root / "docs/docs-impact.json").read_text()
        self.write("app/ui/src/editor.ts", "updated();\n")
        self.accept()
        valid = (self.root / "docs/docs-impact.json").read_text()
        self.commit("editor change")
        self.write("docs/docs-impact.json", original)
        self.cli("--base", "base", ok=False, contains="source changed")
        reset = json.loads(valid)
        reset["baseline"]["source"]["editor"] = reset["receipts"]["editor"]["source_sha256"]
        reset["receipts"] = {}
        self.write("docs/docs-impact.json", json.dumps(reset))
        self.cli("--base", "base", ok=False, contains="fresh assessment")
        (self.root / "docs/docs-impact.json").unlink()
        self.cli("--base", "base", "--init", "--note", NOTE, ok=False, contains="Cannot reset")

    def test_citation_changed_only_before_base_is_not_fresh(self):
        self.write("app/ui/src/editor.ts", "updated();\n")
        self.write("README.md", "Document the changed editor selection behavior.\n")
        self.accept(docs="README.md")
        self.commit("document editor")
        self.git("tag", "later")
        self.write("app/ui/src/editor.ts", "updatedAgain();\n")
        self.cli("--base", "later", "--accept", "editor", "--docs", "README.md", "--note", NOTE, ok=False, contains="has not changed")

    def test_full_history_migration_cannot_hide_behind_later_query(self):
        self.write(HOST + "store/mod.rs", "const SCHEMA_VERSION: u32 = 18;\nfn query() { select(); }\n")
        self.commit("schema migration")
        self.write(HOST + "store/mod.rs", "const SCHEMA_VERSION: u32 = 18;\nfn query() { faster_select(); }\n")
        self.commit("ordinary query edit")
        self.cli("--base", "base", "--accept", "schema", "--no-impact", NOTE, ok=False, contains="no-impact is unavailable")
        self.write("docs/COMPATIBILITY.md", "Back up before upgrade; restore previous backup to roll back.\n")
        for domain in ("schema", "project-format"):
            self.accept(domain, "docs/COMPATIBILITY.md", migration=MIGRATION)
        self.accept("maintenance")
        self.cli("--base", "base")
        self.cli("--release-base", "base")
        self.write("docs/COMPATIBILITY.md", "Initial documentation.\n")
        self.cli("--release-base", "base", ok=False, contains="stale or missing cited")

    def test_schema_column_change_without_marker_change_is_sensitive(self):
        self.write(HOST + "store/other.rs", 'const SCHEMA_V18: &str = "CREATE TABLE sample (\nname TEXT\n);";\n')
        self.commit("existing schema statement")
        self.git("tag", "ddl-base")
        self.write(HOST + "store/other.rs", 'const SCHEMA_V18: &str = "CREATE TABLE sample (\nname BLOB\n);";\n')
        self.cli("--base", "ddl-base", "--accept", "schema", "--no-impact", NOTE, ok=False, contains="no-impact is unavailable")

    def test_schema_constant_data_migration_body_is_sensitive(self):
        self.write(HOST + "store/other.rs", 'const SCHEMA_V18: &str = "UPDATE meta SET value = 1;";\n')
        self.commit("existing schema data migration")
        self.git("tag", "data-base")
        self.write(HOST + "store/other.rs", 'const SCHEMA_V18: &str = "UPDATE meta SET value = 2;";\n')
        self.cli("--base", "data-base", "--accept", "schema", "--no-impact", NOTE, ok=False, contains="no-impact is unavailable")

    def test_profile_migration_body_cannot_use_waiver(self):
        self.write(HOST + "data_migration.rs", 'const LEGACY_DIR: &str = "new";\nfn prepare_copy() { new_location(); }\n')
        self.cli("--base", "base", "--accept", "backup-recovery", "--no-impact", NOTE, ok=False, contains="no-impact is unavailable")
        self.write("docs/COMPATIBILITY.md", "Back up the old profile before migration; restore it for rollback.\n")
        self.cli("--base", "base", "--accept", "schema", "--docs", "docs/COMPATIBILITY.md", "--note", NOTE, "--migration", "Migration is safe and should succeed for everyone.", ok=False, contains="compatibility")
        for domain in ("schema", "backup-recovery"):
            self.accept(domain, "docs/COMPATIBILITY.md", migration=MIGRATION)
        self.accept("maintenance")
        self.cli("--base", "base")

    def test_reverted_schema_marker_still_needs_compatibility(self):
        initial = (self.root / (HOST + "store/mod.rs")).read_text()
        self.write(HOST + "store/mod.rs", initial.replace("17", "18"))
        self.commit("migration")
        self.write(HOST + "store/mod.rs", initial)
        self.commit("restore version")
        self.cli("--release-base", "base", "--accept", "schema", "--no-impact", NOTE, ok=False, contains="no-impact is unavailable")

    def test_test_only_schema_and_zip_version_are_not_schema_migrations(self):
        self.write(HOST + "store/mod.rs", "const SCHEMA_VERSION: u32 = 17;\nfn query() { select(); }\n#[cfg(test)]\nmod tests { const SCHEMA_VERSION: u32 = 999; }\n")
        for domain in ("schema", "project-format", "maintenance"):
            self.accept(domain)
        self.cli("--base", "base")
        self.write(HOST + "package_format.rs", "const VERSION: u16 = 21;\n")
        self.cli("--base", "base", "--accept", "project-format", "--no-impact", NOTE, ok=False, contains="no-impact is unavailable")
        self.write("docs/COMPATIBILITY.md", "ZIP extractor requirements remain compatible; back up before upgrade and restore to roll back.\n")
        self.accept("project-format", "docs/COMPATIBILITY.md", migration=MIGRATION)
        self.accept("maintenance")
        self.cli("--base", "base", "--explain", contains="package_format.rs")

    def test_all_domain_map_changes_need_assessment(self):
        with (self.root / "scripts/check-docs.py").open("a") as handle:
            handle.write("\n# Source coverage map review.\n")
        self.cli("--base", "base", ok=False, contains="source changed")
        for domain in ("editor", "project-format", "schema", "backup-recovery", "encryption", "native-packaging", "maintenance"):
            self.accept(domain)
        self.cli("--base", "base")

    def test_shipped_platform_instructions_are_valid_citations(self):
        paths = ("scripts/linux/README.txt", "scripts/windows/README.txt", "scripts/macos/README.txt", "scripts/android/README.md")
        for path in paths:
            self.write(path, "Updated platform installation requirements.\n")
        self.git("add", ".")
        for path in paths:
            with self.subTest(path=path):
                self.accept("native-packaging", path)
        self.accept("maintenance")
        self.cli("--base", "base")

    def test_declared_breaking_editor_change_cannot_use_waiver(self):
        consequence = "The previous editor shortcut is removed and existing workflows must change."
        self.write("app/ui/src/editor.ts", "removeOldShortcut();\n")
        self.cli("--base", "base", "--accept", "editor", "--no-impact", NOTE, "--breaking", consequence, ok=False, contains="no-impact is unavailable")
        self.write("README.md", "Describe the new editor shortcut.\n")
        self.cli("--base", "base", "--accept", "editor", "--docs", "README.md", "--note", NOTE, "--breaking", consequence, ok=False, contains="COMPATIBILITY.md")
        self.write("docs/COMPATIBILITY.md", "Previous shortcuts are removed. Back up before upgrading; restore the backup with the old version to roll back.\n")
        self.cli("--base", "base", "--accept", "editor", "--docs", "docs/COMPATIBILITY.md", "--note", NOTE, "--breaking", consequence, ok=False, contains="Migration note")
        self.accept("editor", "docs/COMPATIBILITY.md", breaking=consequence, migration=MIGRATION)
        self.cli("--base", "base")
        self.commit("document breaking editor change")
        self.cli()  # A valid historical breaking receipt stays valid.
        lock = json.loads((self.root / "docs/docs-impact.json").read_text())
        lock["receipts"]["editor"]["docs"] = {}
        lock["receipts"]["editor"]["no_impact"] = NOTE
        self.write("docs/docs-impact.json", json.dumps(lock))
        self.cli(ok=False, contains="no-impact is unavailable")

    def test_only_mapped_files_are_read_and_symlinks_are_refused(self):
        excluded = self.root / "lab/excluded.rs"
        excluded.parent.mkdir()
        excluded.symlink_to("/proc/self/mem")
        self.git("add", "lab/excluded.rs")
        self.cli("--base", "base")  # Reading this excluded target would fail.
        source = self.root / "app/ui/src/linked.ts"
        source.symlink_to(self.root / "README.md")
        self.git("add", "app/ui/src/linked.ts")
        self.cli("--base", "base", ok=False, contains="must not be symlinks")
        source.unlink()
        self.git("rm", "--cached", "app/ui/src/linked.ts")
        document = self.root / "README.md"
        document.unlink()
        document.symlink_to(self.root / "docs/COMPATIBILITY.md")
        self.git("add", "README.md")
        self.cli("--base", "base", ok=False, contains="must not be symlinks: README.md")

    def test_cargo_dependency_changes_require_encryption_assessment(self):
        self.write("app/shell-tauri/src-tauri/Cargo.toml", '[dependencies]\nargon2 = "0.5"\n')
        self.git("add", "app/shell-tauri/src-tauri/Cargo.toml")
        self.cli("--base", "base", ok=False, contains="encryption: source changed")
        self.accept("encryption")
        self.accept("native-packaging")
        self.cli("--base", "base")

    def test_release_base_must_be_reachable_ancestor(self):
        self.git("checkout", "-qb", "other-release", "base")
        self.write("other.txt", "Divergent release history.\n")
        self.commit("divergent release")
        self.git("tag", "unreachable-release")
        self.git("checkout", "-q", "base")
        self.cli("--release-base", "unreachable-release", ok=False, contains="must be an ancestor of HEAD")
        self.cli("--release-base", "base")

    def test_upstream_migrations_are_not_new_pr_obligations(self):
        self.git("branch", "feature", "base")
        self.write("upstream.txt", "Earlier upstream change.\n")
        self.commit("earlier upstream change")
        self.git("tag", "early-upstream")
        self.git("checkout", "-q", "feature")
        self.write("unmapped.txt", "Unrelated feature change.\n")
        self.commit("unrelated feature")
        self.git("merge", "--no-ff", "-qm", "earlier upstream merge", "early-upstream")
        self.git("checkout", "-qb", "upstream", "early-upstream")
        self.write(HOST + "store/mod.rs", "const SCHEMA_VERSION: u32 = 18;\n")
        self.write("docs/COMPATIBILITY.md", MIGRATION)
        for domain in ("schema", "project-format"):
            self.accept(domain, "docs/COMPATIBILITY.md", migration=MIGRATION)
        self.accept("maintenance")
        self.commit("document upstream migration")
        self.git("tag", "updated-base")
        self.git("checkout", "-q", "feature")
        self.git("branch", "unmerged-feature")
        self.git("merge", "--no-ff", "-qm", "merge upstream into feature", "updated-base")
        self.cli("--base", "updated-base")
        self.git("checkout", "-qb", "synthetic", "updated-base")
        self.git("merge", "--no-ff", "-qm", "synthetic PR checkout", "unmerged-feature")
        self.cli("--base", "updated-base")

    def test_reverted_merge_resolution_migration_is_retained(self):
        self.git("checkout", "-qb", "left", "base")
        self.write(HOST + "store/mod.rs", "const SCHEMA_VERSION: u32 = 17;\nfn query() { left(); }\n")
        self.commit("left query")
        self.git("checkout", "-qb", "right", "base")
        self.write(HOST + "store/mod.rs", "const SCHEMA_VERSION: u32 = 17;\nfn query() { right(); }\n")
        self.commit("right query")
        self.git("merge", "--no-ff", "--no-commit", "left", expected=1)
        self.write(HOST + "store/mod.rs", "const SCHEMA_VERSION: u32 = 18;\nfn query() { resolved(); }\n")
        self.commit("merge introduces migration")
        self.write(HOST + "store/mod.rs", "const SCHEMA_VERSION: u32 = 17;\nfn query() { resolved(); }\n")
        self.commit("revert migration marker")
        self.cli("--release-base", "base", "--accept", "schema", "--no-impact", NOTE, ok=False, contains="no-impact is unavailable")

    def test_missing_git_base_and_shallow_history_fail_clearly(self):
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        self.cli(cwd=outside, ok=False, contains="Git command failed")
        self.cli("--base", "missing-ref", ok=False, contains="Git command failed")
        clone = Path(self.temp.name) / "shallow"
        self.git("clone", "-q", "--depth", "1", self.root.as_uri(), str(clone))
        self.cli(cwd=clone, ok=False, contains="Shallow Git history")


if __name__ == "__main__":
    unittest.main()
