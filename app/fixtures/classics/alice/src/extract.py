#!/usr/bin/env python3
"""Extract chapters I-III from the preserved Gutenberg source, offline."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
TITLE = "Alice's Adventures in Wonderland"
SCENES = ['Down the Rabbit-Hole', 'The Pool of Tears', 'A Caucus-Race and a Long Tale']
source = (ROOT / "source.txt").read_text(encoding="utf-8-sig")
pattern = r"^CHAPTER ([IVX]+)\.\n([^\n]+)"
headings = list(re.finditer(pattern, source, re.M))
assert [m.group(1) for m in headings[:4]] == ["I", "II", "III", "IV"]
parts = ["# " + TITLE, "## Opening chapters"]
scene_index = 0
for index in range(3):
    heading = headings[index]
    body = source[heading.end():headings[index + 1].start()].strip()
    chapter = "Chapter " + heading.group(1) + ". " + heading.group(2)
    chunks = [body]
    parts.append("### " + chapter)
    for chunk in chunks:
        parts.append("#### " + SCENES[scene_index])
        # Source indentation is typography, not Markdown code. Preserve all
        # wording, punctuation, line breaks, paragraph breaks and emphasis.
        parts.append("\n".join(line.lstrip() for line in chunk.splitlines()))
        scene_index += 1
assert scene_index == len(SCENES)
(ROOT / "manuscript.md").write_text("\n\n".join(parts) + "\n", encoding="utf-8")
