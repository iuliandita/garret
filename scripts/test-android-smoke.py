#!/usr/bin/env python3
"""Offline Android hierarchy matching and scroll regressions."""
import copy
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("smoke", Path(__file__).parent / "android/smoke.py")
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)
FIXTURES = Path(__file__).parent / "fixtures/android-smoke"


def dump(name):
    return list(ET.parse(FIXTURES / f"{name}.xml").getroot().iter("node"))


def hidden_dialog():
    nodes = dump("outline-keyboard")
    dialog = next(n for n in nodes if n.get("class") == "android.app.Dialog")
    left, _, right, bottom = smoke.bounds(dialog)
    button = next(n for n in nodes if n.get("text") == "Add scene")
    button.set("bounds", f"[{left},{bottom}][{right},{bottom}]")
    return nodes


class AndroidSmokeTests(unittest.TestCase):
    def test_scene_buttons_match_only_exact_or_contextual_labels(self):
        button = next(n for n in dump("outline-keyboard") if n.get("text") == "Scene 1")
        for attribute in ("text", "content-desc"):
            for label, expected in (("Scene 1", True), ("Chapter 1, Scene 1", True),
                                    ("Szene 1", True), ("Kapitel 1, Szene 1", True),
                                    ("Chapter 1, Scene 10", False), ("My Scene 1", False),
                                    ("Scene 1, Chapter 1", False)):
                with self.subTest(attribute=attribute, label=label):
                    node = copy.deepcopy(button)
                    node.set("text", "")
                    node.set("content-desc", "")
                    node.set(attribute, label)
                    self.assertEqual(smoke.matches_text(node, ("Scene 1", "Szene 1"), scene=True), expected)
                    node.set("class", "android.widget.TextView")
                    self.assertFalse(smoke.matches_text(node, ("Scene 1", "Szene 1"), scene=True))
        button.set("text", "Chapter 1, Scene 1")
        self.assertFalse(smoke.matches_text(button, ("Scene 1",)))

    def test_missing_and_ambiguous_controls_never_tap_or_scroll(self):
        nodes = dump("outline-keyboard")
        button = next(n for n in nodes if n.get("text") == "Add scene")
        for candidates, label, error in ((nodes, "Absent", "missing"),
                                         (nodes + [copy.deepcopy(button)], "Add scene", "ambiguous")):
            with self.subTest(error=error), patch.object(smoke, "adb") as adb:
                with self.assertRaisesRegex(RuntimeError, f"UI control {error}"):
                    smoke.tap_text(candidates, label, out=Path("."))
                adb.assert_not_called()

    def test_scroll_decision_uses_visible_dialog_bounds(self):
        hidden = hidden_dialog()
        visible = dump("outline-scrolled")
        button = next(n for n in hidden if n.get("text") == "Add scene")
        dialog = next(n for n in hidden if n.get("class") == "android.app.Dialog")
        swipe = smoke.scroll_swipe(hidden, button)
        left, top, right, bottom = smoke.bounds(dialog)
        x1, y1, x2, y2 = swipe
        self.assertTrue(left < x1 == x2 < right and top < y2 < y1 < bottom)
        self.assertIsNone(smoke.scroll_swipe(visible, next(n for n in visible if n.get("text") == "Add scene")))
        for rectangle, downward in ((f"[{left},{bottom + 10}][{right},{bottom + 80}]", False),
                                    (f"[{left},{top - 80}][{right},{top - 10}]", True)):
            with self.subTest(rectangle=rectangle):
                button.set("bounds", rectangle)
                _, start, _, end = smoke.scroll_swipe(hidden, button)
                self.assertEqual(start < end, downward)

    def test_scroll_refreshes_before_tap_and_stops_when_unreachable(self):
        hidden, visible = hidden_dialog(), dump("outline-scrolled")
        with patch.object(smoke, "hierarchy", return_value=visible), patch.object(smoke, "adb") as adb:
            smoke.tap_text(hidden, "Add scene", out=Path("."))
            self.assertEqual([call.args[2] for call in adb.call_args_list], ["swipe", "tap"])
            x1, y1, x2, y2 = smoke.bounds(next(n for n in visible if n.get("text") == "Add scene"))
            self.assertEqual(adb.call_args.args, ("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2)))
        for refreshed, error in ((hidden, "not visible after 4 scrolls"), ([], "missing"),
                                 (visible + [copy.deepcopy(next(n for n in visible if n.get("text") == "Add scene"))], "ambiguous")):
            with self.subTest(error=error), patch.object(smoke, "hierarchy", return_value=refreshed), patch.object(smoke, "adb") as adb:
                with self.assertRaisesRegex(RuntimeError, error):
                    smoke.tap_text(hidden, "Add scene", out=Path("."))
                self.assertLessEqual(adb.call_count, 4)
                self.assertTrue(all(call.args[2] == "swipe" for call in adb.call_args_list))


if __name__ == "__main__":
    unittest.main()
