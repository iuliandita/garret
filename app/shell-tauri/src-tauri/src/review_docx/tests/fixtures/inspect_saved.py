"""Record actual editor package changes without importing application code."""
from pathlib import Path
from zipfile import ZipFile
import argparse
import hashlib
import json
from lxml import etree

parser = argparse.ArgumentParser()
parser.add_argument("original", type=Path)
parser.add_argument("saved", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
APP = "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"

def describe(path: Path) -> dict:
    with ZipFile(path) as archive:
        names = archive.namelist()
        document = etree.fromstring(archive.read("word/document.xml"))
        props = {}
        if "docProps/custom.xml" in names:
            props = {p.get("name"): p[0].text for p in etree.fromstring(archive.read("docProps/custom.xml"))}
        application = None
        if "docProps/app.xml" in names:
            app = etree.fromstring(archive.read("docProps/app.xml"))
            application = app.findtext(f"{{{APP}}}Application")
        return {
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "application": application,
            "parts": names,
            "bookmarks": document.xpath("//w:bookmarkStart/@w:name", namespaces={"w": W}),
            "block_controls": len(document.findall(f"./{{{W}}}body/{{{W}}}sdt")),
            "properties": props,
        }

results = []
for path in sorted(args.saved.glob("*.docx")):
    saved = describe(path)
    original_path = args.original / path.name
    original = describe(original_path) if original_path.exists() else None
    results.append({
        "file": path.name,
        "original_sha256": original["sha256"] if original else None,
        "saved_sha256": saved["sha256"],
        "producer": saved["application"],
        "manifest_chunks_preserved": saved["properties"] == original["properties"] if original else None,
        "bookmark_names_preserved": saved["bookmarks"] == original["bookmarks"] if original else None,
        "saved_block_controls": saved["block_controls"],
        "saved_parts": saved["parts"],
    })
args.output.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
print(f"Recorded {len(results)} actual saved packages")
