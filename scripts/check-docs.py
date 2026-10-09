#!/usr/bin/env python3
"""Offline, Git-aware documentation impact receipts. No third-party dependencies."""
import argparse
import fnmatch
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

LOCK = "docs/docs-impact.json"
HOST = "app/shell-tauri/src-tauri/"
# One map owns both source coverage and the documentation each domain may cite.
DOMAINS = {
    "editor": {
        "sources": ["app/ui/src/*", "app/ui/*.html", "app/ui/*.css", "app/mobile/*", "scripts/android/*.kt", HOST + "src/mobile*.rs"],
        "docs": ["README.md", "docs/screenshots/README.md", "docs/screenshots/manifest.json", "docs/MAINTENANCE.md"],
    },
    "project-format": {
        "sources": [HOST + "src/store*", HOST + "src/*import*.rs", HOST + "src/*export*.rs", HOST + "src/mirror*.rs", HOST + "src/package_format.rs", HOST + "src/projects.rs", HOST + "src/design_transfer.rs", HOST + "src/review_docx/*"],
        "docs": ["README.md", "docs/COMPATIBILITY.md", "docs/MAINTENANCE.md"],
    },
    "schema": {
        "sources": [HOST + "src/store*", HOST + "src/data_migration.rs", HOST + "src/core_constants.rs"],
        "docs": ["docs/COMPATIBILITY.md", "docs/MAINTENANCE.md"],
    },
    "backup-recovery": {
        "sources": [HOST + "src/*backup*.rs", HOST + "src/*recovery*.rs", HOST + "src/*salvage*.rs", HOST + "src/encrypted_archive.rs", HOST + "src/data_migration.rs", HOST + "src/transfer*.rs"],
        "docs": ["README.md", "docs/COMPATIBILITY.md", "docs/MAINTENANCE.md"],
    },
    "encryption": {
        "sources": [HOST + "src/encrypted_archive.rs", HOST + "src/protection.rs"],
        "docs": ["README.md", "docs/COMPATIBILITY.md", "docs/MAINTENANCE.md"],
    },
    "native-packaging": {
        "sources": [HOST + "Cargo.*", HOST + "build.rs", HOST + "tauri*.json", HOST + "capabilities/*", HOST + "command-boundary/*", "scripts/package-*", "scripts/android/*", "scripts/linux/*", "scripts/windows/*", "scripts/macos/*", ".github/workflows/*"],
        "docs": ["README.md", "docs/COMPATIBILITY.md", "docs/RELEASES.md", "docs/releases.json", "docs/MAINTENANCE.md", "CONTRIBUTING.md"],
    },
    "maintenance": {
        "sources": [HOST + "src/*", "scripts/*", ".github/workflows/*", "package.json", "bun.lock*", "app/ui/package.json", "app/tsconfig.json"],
        "docs": ["docs/MAINTENANCE.md", "docs/RELEASES.md", "CONTRIBUTING.md"],
    },
}
ALL_DOMAIN_SOURCES = {"scripts/check-docs.py"}
EXCLUDED_PARTS = {"test", "tests", "fixtures", "results", "generated", "dist", "target", "node_modules"}
SENSITIVE = re.compile(r"SCHEMA_VERSION|SCHEMA_V[0-9]+|(?:CREATE|ALTER|DROP)\s+TABLE|\bfn\s+\w*(?:migrat|upgrade)\w*", re.I)
TEST_BOUNDARY = re.compile(r"#\[cfg\(test\)\]\s*(?:pub\s+)?mod\s+tests\s*\{")


class Failure(Exception):
    pass


def git(*args, allow_missing=False):
    result = subprocess.run(["git", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode and not allow_missing:
        raise Failure(f"Git command failed ({' '.join(args)}): {result.stderr.decode(errors='replace').strip()}")
    return result.stdout if result.returncode == 0 else None


def names(data):
    return set(data.decode().strip("\0").split("\0")) - {""}


def source_domains(path):
    parts = Path(path).parts
    if path.startswith(("lab/", "docs/", ".agents/")) or EXCLUDED_PARTS.intersection(parts):
        return set()
    if path in {"scripts/test-docs.py", "scripts/test-docs-facts.py"}:
        return {"maintenance"}
    if Path(path).name in {"test_support.rs", "tests.rs", "crash_child.rs"} or re.search(r"(?:^|/)(?:test[-_]|.*[.]test[.])", path):
        return set()
    if path in ALL_DOMAIN_SOURCES:
        return set(DOMAINS)
    return {domain for domain, rule in DOMAINS.items() if any(fnmatch.fnmatchcase(path, pattern) for pattern in rule["sources"])}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def current_files():
    # The index includes staged additions, but not unrelated untracked scratch.
    return {p: Path(p).read_bytes() for p in names(git("ls-files", "-z")) if Path(p).is_file()}


def digests(files):
    result = {}
    for domain in DOMAINS:
        digest = hashlib.sha256()
        for path, content in sorted(files.items()):
            if domain in source_domains(path):
                encoded = path.encode()
                digest.update(len(encoded).to_bytes(8, "big") + encoded)
                digest.update(len(content).to_bytes(8, "big") + content)
        result[domain] = digest.hexdigest()
    return result


def reason(text, label):
    if not isinstance(text, str) or len(text.strip()) < 24 or len(set(re.findall(r"[a-z]+", text.lower()))) < 4:
        raise Failure(f"{label} needs a specific explanation (at least 24 characters and four different words).")
    normalized = re.sub(r"[^a-z ]", "", text.lower()).strip()
    if normalized in {"no documentation impact", "no docs impact", "documentation is up to date", "docs are up to date", "no changes needed", "not applicable"}:
        raise Failure(f"{label} must explain the actual change, not use a generic waiver.")
    return text.strip()


def read_lock(data):
    try:
        lock = json.loads(data)
        if lock["version"] != 1 or not isinstance(lock["baseline"]["source"], dict) or not isinstance(lock["receipts"], dict):
            raise ValueError("unsupported shape")
        return lock
    except (ValueError, KeyError, TypeError) as error:
        raise Failure(f"Invalid {LOCK}: {error}") from error


def production(data):
    return TEST_BOUNDARY.split(data.decode(errors="replace"), maxsplit=1)[0]


def sensitive_path(path):
    if path == HOST + "src/package_format.rs":
        return True
    return path.startswith(HOST + "src/") and ("/store/" in path or Path(path).name.startswith("store") or Path(path).name == "data_migration.rs") and bool(source_domains(path))


def migration_bodies(text):
    bodies = []
    for match in re.finditer(r"\bfn\s+\w*(?:migrat|upgrade)\w*[^;{]*\{", text, re.I):
        depth = 1
        end = match.end()
        while end < len(text) and depth:
            depth += (text[end] == "{") - (text[end] == "}")
            end += 1
        bodies.append(text[match.start():end])
    return bodies


def schema_blocks(text):
    pattern = r'\bconst\s+SCHEMA_V\d+\s*:[^=]*=\s*(?:"(?:\\.|[^"\\])*"|r(?P<hashes>#{0,8})".*?"(?P=hashes))'
    return [match.group() for match in re.finditer(pattern, text, re.S)]


def sensitive_change(before, after, path):
    # Compare production lines, so a query edit near a schema declaration is not
    # confused with changing the declaration itself.
    import difflib
    if path == HOST + "src/package_format.rs":
        return production(before) != production(after)
    before_text, after_text = production(before), production(after)
    if schema_blocks(before_text) != schema_blocks(after_text):
        return True
    if migration_bodies(before_text) != migration_bodies(after_text):
        return True
    # Compare whole DDL statements: changing a column on the next line must
    # count even when the CREATE TABLE marker itself stays unchanged.
    ddl = r"\b(?:CREATE|ALTER|DROP)\s+TABLE\b[^;]*;"
    if re.findall(ddl, before_text, re.I) != re.findall(ddl, after_text, re.I):
        return True
    lines = difflib.unified_diff(production(before).splitlines(), production(after).splitlines(), n=0)
    return any(SENSITIVE.search(line[1:]) for line in lines if line.startswith(("+", "-")) and not line.startswith(("+++", "---")))


def range_state(base, files):
    changed = names(git("diff", "--name-only", "--no-renames", "-z", base, "--"))
    commits = git("rev-list", "--reverse", f"{base}..HEAD").decode().splitlines()
    sensitive = set()
    # Inspect every committed transition, not just HEAD or the net diff. A later
    # version bump or reverted migration must not hide a compatibility obligation.
    for commit in commits:
        parents = git("rev-list", "--parents", "-n", "1", commit).decode().split()[1:]
        for parent in parents:
            paths = names(git("diff", "--name-only", "--no-renames", "-z", parent, commit, "--"))
            changed.update(paths)
            for path in paths:
                if sensitive_path(path) and sensitive_change(git("show", f"{parent}:{path}", allow_missing=True) or b"", git("show", f"{commit}:{path}", allow_missing=True) or b"", path):
                    sensitive.add(path)
    for path in changed:
        if sensitive_path(path) and sensitive_change(git("show", f"{base}:{path}", allow_missing=True) or b"", files.get(path, b""), path):
            sensitive.add(path)
    impacted = set().union(*(source_domains(p) for p in changed)) if changed else set()
    return changed, impacted, sensitive


def compatibility_note(record):
    text = reason(record.get("migration", ""), "Migration note")
    for concept, pattern in {"compatibility": r"compatib|older|previous|forward", "backup": r"backup|back up|copy", "upgrade": r"upgrad|migrat|open", "rollback": r"rollback|roll back|downgrad|restore"}.items():
        if not re.search(pattern, text, re.I):
            raise Failure(f"Migration note must explain {concept} steps or limits.")
    breaking = record.get("breaking", "")
    if breaking != "none":
        reason(breaking, "Breaking-change assessment")


def validate_record(domain, record, fingerprint, files):
    if not isinstance(record, dict) or record.get("source_sha256") != fingerprint:
        raise Failure(f"{domain}: missing or stale source receipt; reassess with --accept {domain}.")
    reason(record.get("note", ""), f"{domain} note")
    no_impact = record.get("no_impact")
    cited = record.get("docs")
    if not isinstance(cited, dict):
        raise Failure(f"{domain}: receipt docs must be a path-to-hash object.")
    if no_impact:
        reason(no_impact, f"{domain} no-impact reason")
        if cited:
            raise Failure(f"{domain}: a no-impact assessment cannot cite changed docs.")
    elif not cited:
        raise Failure(f"{domain}: cite updated documentation or explain --no-impact.")
    for path, expected in cited.items():
        if path not in DOMAINS[domain]["docs"]:
            raise Failure(f"{domain}: unrelated documentation citation: {path}")
        if path not in files or sha(files[path]) != expected:
            raise Failure(f"{domain}: stale or missing cited documentation: {path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    base_group = parser.add_mutually_exclusive_group()
    base_group.add_argument("--base", help="PR base ref; assess its merge-base with HEAD plus local changes")
    base_group.add_argument("--release-base", help="exact earlier release ref; assess the full range plus local changes")
    parser.add_argument("--explain", action="store_true")
    parser.add_argument("--init", action="store_true")
    parser.add_argument("--accept", choices=DOMAINS)
    parser.add_argument("--docs", help="comma-separated changed documentation paths")
    parser.add_argument("--note")
    parser.add_argument("--no-impact")
    parser.add_argument("--breaking", default="none", help="none or a specific breaking-change explanation")
    parser.add_argument("--migration", default="")
    args = parser.parse_args()
    root = git("rev-parse", "--show-toplevel").decode().strip()
    import os
    os.chdir(root)
    if git("rev-parse", "--is-shallow-repository").strip() == b"true":
        raise Failure("Shallow Git history cannot prove the complete range; fetch full history first.")
    git("rev-parse", "--verify", "HEAD^{commit}")
    ref = args.release_base or args.base or "HEAD"
    resolved = git("rev-parse", "--verify", f"{ref}^{{commit}}").decode().strip()
    base = git("merge-base", resolved, "HEAD").decode().strip() if args.base else resolved
    files = current_files()
    fingerprints = digests(files)
    changed, impacted, sensitive = range_state(base, files)
    if args.explain:
        print(f"Comparison base: {base}")
        for domain in DOMAINS:
            paths = sorted(p for p in changed if domain in source_domains(p))
            print(f"{domain}: {', '.join(paths) if paths else 'no source changes'}")
        if sensitive:
            print("Sensitive production schema/format/profile migration changes: " + ", ".join(sorted(sensitive)))
    sensitive_domains = set().union(*(source_domains(p) for p in sensitive)) & {"schema", "project-format", "backup-recovery"} if sensitive else set()
    lock_path = Path(LOCK)
    if args.init:
        if args.accept or args.docs or args.no_impact or args.migration or args.breaking != "none":
            raise Failure("--init accepts only --note and optional base/explain flags.")
        if lock_path.exists():
            raise Failure(f"{LOCK} already exists; --init cannot reset receipts.")
        if git("show", f"{base}:{LOCK}", allow_missing=True) is not None:
            raise Failure("Cannot reset a receipt store that exists at the comparison base.")
        lock = {"version": 1, "baseline": {"note": reason(args.note, "Baseline note"), "source": fingerprints}, "receipts": {}}
    else:
        if not lock_path.is_file():
            raise Failure(f"Missing {LOCK}; initialize the explicit baseline with --init --note.")
        lock = read_lock(lock_path.read_bytes())
    if args.accept:
        if bool(args.docs) == bool(args.no_impact):
            raise Failure("--accept needs exactly one of --docs or --no-impact.")
        note = reason(args.note or args.no_impact, "Assessment note")
        cited = {}
        for path in (args.docs or "").split(","):
            if not path:
                continue
            if path not in DOMAINS[args.accept]["docs"] or path not in files:
                raise Failure(f"{args.accept}: documentation must be an allowed tracked file: {path}")
            if (git("show", f"{base}:{path}", allow_missing=True) or b"") == files[path]:
                raise Failure(f"{args.accept}: cited documentation has not changed against base: {path}")
            cited[path] = sha(files[path])
        record = {"source_sha256": fingerprints[args.accept], "docs": cited, "note": note, "no_impact": args.no_impact or "", "breaking": args.breaking, "migration": args.migration}
        validate_record(args.accept, record, fingerprints[args.accept], files)
        if args.accept in sensitive_domains:
            if args.no_impact or "docs/COMPATIBILITY.md" not in cited:
                raise Failure("Schema/format/profile migration changes require changed docs/COMPATIBILITY.md; no-impact is unavailable.")
            compatibility_note(record)
        lock["receipts"][args.accept] = record
    if args.init or args.accept:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        lock_path.write_text(json.dumps(lock, indent=2, sort_keys=True) + "\n")
        print(f"Recorded {'explicit baseline' if args.init else args.accept} in {LOCK}.")
        return
    baseline = lock["baseline"]["source"]
    base_data = git("show", f"{base}:{LOCK}", allow_missing=True)
    base_lock = read_lock(base_data) if base_data is not None else {"receipts": {}}
    for domain, fingerprint in fingerprints.items():
        record = lock["receipts"].get(domain)
        if record:
            validate_record(domain, record, fingerprint, files)
        elif baseline.get(domain) != fingerprint:
            raise Failure(f"{domain}: source changed since baseline; record a documentation assessment.")
        if domain in impacted:
            if not record or record == base_lock["receipts"].get(domain):
                raise Failure(f"{domain}: range changes require a fresh assessment; baseline/reset receipts do not count.")
            for path in record["docs"]:
                if (git("show", f"{base}:{path}", allow_missing=True) or b"") == files[path]:
                    raise Failure(f"{domain}: cited documentation has not changed against base: {path}")
            if domain in sensitive_domains:
                if record["no_impact"] or "docs/COMPATIBILITY.md" not in record["docs"]:
                    raise Failure("Schema/format/profile migration changes require changed docs/COMPATIBILITY.md; no-impact is unavailable.")
                compatibility_note(record)
    print("Documentation impact receipts match current sources and cited documentation.")


if __name__ == "__main__":
    try:
        main()
    except (Failure, OSError) as error:
        print(f"docs guard: {error}", file=sys.stderr)
        sys.exit(1)
