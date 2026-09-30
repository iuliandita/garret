#!/usr/bin/env python3
"""Extract the opening three chapters from the retained Gutenberg source."""
from pathlib import Path
import re

root = Path(__file__).resolve().parent
source = (root / "source.txt").read_text()
start = source.index("It is a truth universally acknowledged")
end = source.index("CHAPTER IV.", start)
excerpt = source[start:end]

# Illustration captions interrupt sentences in this edition. Remove their
# balanced brackets, including nested credit lines, before joining paragraphs.
while "[Illustration" in excerpt:
    first = excerpt.index("[Illustration")
    depth = 0
    for last in range(first, len(excerpt)):
        depth += (excerpt[last] == "[") - (excerpt[last] == "]")
        if depth == 0:
            excerpt = excerpt[:first] + excerpt[last + 1:]
            break
    else:
        raise ValueError("Unclosed illustration caption")

chapters = re.split(r"CHAPTER (?:II|III)\.", excerpt)
assert len(chapters) == 3
scenes = ["A new neighbor", "Mr. Bennet's visit", "The assembly"]
output = ["# Pride and Prejudice", "", "## Opening chapters", ""]
for number, (chapter, scene) in enumerate(zip(chapters, scenes), 1):
    paragraphs = [" ".join(p.split()) for p in re.split(r"\n\s*\n", chapter) if p.strip()]
    # One illustration was placed in the middle of this sentence.
    if number == 3:
        at = next(i for i, p in enumerate(paragraphs) if p.endswith("starting the idea of his"))
        paragraphs[at:at + 2] = [paragraphs[at] + " " + paragraphs[at + 1]]
    output.extend([f"### Chapter {number}", "", f"#### {scene}", "", "\n\n".join(paragraphs), ""])
(root / "manuscript.md").write_text("\n".join(output))
