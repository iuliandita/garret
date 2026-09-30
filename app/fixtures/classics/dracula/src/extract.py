#!/usr/bin/env python3
"""Extract chapters I-III from the preserved Gutenberg source, offline."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
TITLE = 'Dracula'
SCENES = ['3 May: Bistritz', '4 May: The Crucifix', '5 May: The Borgo Pass', '5 May: The Count Welcomes His Guest', '7 May: English Books and Carfax', '8 May: The Mirror and Locked Doors', 'A Prisoner in the Castle', '12 May: The Count Descends the Wall', '15 May: The Deserted Rooms', '16 May: The Three Women']
source = (ROOT / "source.txt").read_text(encoding="utf-8-sig")
pattern = r"^CHAPTER ([IVX]+)\n\n([^\n]+)"
headings = list(re.finditer(pattern, source, re.M))
assert [m.group(1) for m in headings[:4]] == ["I", "II", "III", "IV"]
parts = ["# " + TITLE, "## Opening chapters"]
scene_index = 0
for index in range(3):
    heading = headings[index]
    body = source[heading.end():headings[index + 1].start()].strip()
    chapter = "Chapter " + heading.group(1) + ": Jonathan Harker's Journal"
    # Journal headings are retained inside the first scene of each chapter.
    body = heading.group(2) + "\n\n" + body
    markers = list(re.finditer(r"^_(?:[3-8]|12|15) May\.|^_Later: the Morning", body, re.M))
    starts = [m.start() for m in markers]
    if starts and starts[0] > 0:
        if index < 2:
            starts[0] = 0
        else:
            starts.insert(0, 0)
    chunks = [body[a:b].strip() for a, b in zip(starts, starts[1:] + [len(body)])]
    parts.append("### " + chapter)
    for chunk in chunks:
        parts.append("#### " + SCENES[scene_index])
        # Source indentation is typography, not Markdown code. Preserve all
        # wording, punctuation, line breaks, paragraph breaks and emphasis.
        parts.append("\n".join(line.lstrip() for line in chunk.splitlines()))
        scene_index += 1
assert scene_index == len(SCENES)
(ROOT / "manuscript.md").write_text("\n\n".join(parts) + "\n", encoding="utf-8")
