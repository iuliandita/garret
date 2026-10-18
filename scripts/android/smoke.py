#!/usr/bin/env python3
"""Fresh headless Android book/edit/reopen smoke check. Run inside garret-android-emulator."""

from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET


PKG = "com.usegarret.app"
IMAGE = "system-images;android-36;google_apis;x86_64"
SERIAL = "emulator-5554"
BOUNDS = re.compile(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]")


def run(*args: str, env: dict[str, str] | None = None, timeout: int = 30,
        answer: str | None = None) -> str:
    done = subprocess.run(args, env=env, text=True, capture_output=True,
                          input=answer, timeout=timeout)
    if done.returncode:
        raise RuntimeError(f"{args[0]} {args[1:]} failed ({done.returncode}): {done.stderr[-1500:]}")
    return done.stdout


def adb(*args: str, timeout: int = 30) -> str:
    return run("adb", "-s", SERIAL, *args, timeout=timeout)


def screenshot(out: Path, name: str) -> None:
    with (out / f"{name}.png").open("wb") as file:
        done = subprocess.run(("adb", "-s", SERIAL, "exec-out", "screencap", "-p"), stdout=file, stderr=subprocess.PIPE, timeout=30)
    if done.returncode:
        raise RuntimeError(f"screencap failed: {done.stderr.decode(errors='replace')[-500:]}")


def hierarchy(out: Path, name: str) -> list[ET.Element]:
    adb("shell", "uiautomator", "dump", "/sdcard/write227.xml", timeout=45)
    xml = adb("exec-out", "cat", "/sdcard/write227.xml")
    (out / f"{name}.xml").write_text(xml)
    return list(ET.fromstring(xml).iter("node"))


def node_text(node: ET.Element) -> str:
    return " ".join(node.attrib.get(key, "") for key in ("text", "content-desc"))


def wait_nodes(out: Path, name: str, predicate, timeout: int = 30) -> list[ET.Element]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            nodes = hierarchy(out, name)
            if has(nodes, "This action could not be completed", "Diese Aktion konnte nicht abgeschlossen werden"):
                screenshot(out, f"{name}-operation-error")
                raise RuntimeError(f"app displayed operation error at {name}")
            if predicate(nodes):
                return nodes
        except RuntimeError as error:
            if str(error).startswith("app displayed operation error"):
                raise
        except (ET.ParseError, subprocess.TimeoutExpired):
            pass
        time.sleep(1)
    screenshot(out, f"{name}-timeout")
    raise RuntimeError(f"UI checkpoint {name} was not present within {timeout}s")


def has(nodes: list[ET.Element], *texts: str) -> bool:
    return any(any(text in node_text(node) for text in texts) for node in nodes)


def tap_node(node: ET.Element) -> None:
    match = BOUNDS.fullmatch(node.attrib.get("bounds", ""))
    if match is None:
        raise RuntimeError(f"UI node has no bounds: {node.attrib}")
    x1, y1, x2, y2 = map(int, match.groups())
    if x2 <= x1 or y2 <= y1:
        raise RuntimeError(f"UI node has empty bounds: {node.attrib}")
    adb("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))


def matches_text(node: ET.Element, texts: tuple[str, ...], *, scene: bool = False) -> bool:
    if scene and node.get("class") != "android.widget.Button":
        return False
    return any(label == text or (scene and label.endswith(f", {text}"))
               for label in (node.get("text", ""), node.get("content-desc", ""))
               for text in texts)


def bounds(node: ET.Element) -> tuple[int, int, int, int]:
    match = BOUNDS.fullmatch(node.get("bounds", ""))
    if match is None:
        raise RuntimeError(f"UI node has no bounds: {node.attrib}")
    return tuple(map(int, match.groups()))


def scroll_swipe(nodes: list[ET.Element], node: ET.Element) -> tuple[int, int, int, int] | None:
    ancestors = [parent for parent in nodes if parent is not node and node in parent.iter("node")]
    x1, y1, x2, y2 = bounds(node)
    regions = [bounds(parent) for parent in ancestors]
    if x2 > x1 and y2 > y1 and all(
            left <= x1 < x2 <= right and top <= y1 < y2 <= bottom
            for left, top, right, bottom in regions):
        return None
    containers = [parent for parent in ancestors if parent.get("scrollable") == "true"
                  or parent.get("class") == "android.app.Dialog"]
    if not containers:
        raise RuntimeError("UI control is off-screen without a scrollable ancestor or dialog")
    container = containers[-1]
    left, top, right, bottom = bounds(container)
    for parent in ancestors:
        if parent is container or container not in parent.iter("node"):
            continue
        region = bounds(parent)
        left, top = max(left, region[0]), max(top, region[1])
        right, bottom = min(right, region[2]), min(bottom, region[3])
    if right <= left or bottom - top < 4:
        raise RuntimeError("UI control has no visible scroll region")
    x = (left + right) // 2
    high, low = top + (bottom - top) // 4, bottom - (bottom - top) // 4
    return (x, high, x, low) if y1 <= top else (x, low, x, high)


def tap_text(nodes: list[ET.Element], *texts: str, out: Path,
             scene: bool = False, max_scrolls: int = 4) -> None:
    for attempt in range(max_scrolls + 1):
        matches = [node for node in nodes if matches_text(node, texts, scene=scene)]
        if not matches:
            raise RuntimeError(f"UI control missing: {texts}")
        if len(matches) != 1:
            raise RuntimeError(f"UI control ambiguous: {texts}; found {len(matches)} matches")
        node = matches[0]
        if node.get("enabled") == "false":
            raise RuntimeError(f"UI control disabled: {texts}")
        swipe = scroll_swipe(nodes, node)
        if swipe is None:
            tap_node(node)
            return
        if attempt == max_scrolls:
            raise RuntimeError(f"UI control not visible after {max_scrolls} scrolls: {texts}")
        adb("shell", "input", "swipe", *(str(value) for value in swipe), "300")
        nodes = hierarchy(out, f"scroll-{time.monotonic_ns()}-{attempt + 1}")


def tap_editable(nodes: list[ET.Element], *, last: bool = False) -> None:
    editable = [node for node in nodes if node.attrib.get("class") == "android.widget.EditText"
                and node.attrib.get("enabled") != "false"]
    if len(editable) != 1 and not (last and editable):
        raise RuntimeError(f"expected one editable field, found {len(editable)}; inspect saved hierarchy")
    tap_node(editable[-1] if last else editable[0])


def type_token(token: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9]+", token):
        raise ValueError("input text must be an ASCII alphanumeric token")
    adb("shell", "input", "text", token)


def checkpoint(out: Path, name: str, *text: str) -> list[ET.Element]:
    nodes = wait_nodes(out, name, lambda found: has(found, *text), 45)
    screenshot(out, name)
    return nodes


def atoms(value: dict) -> list[dict]:
    if value.get("type") in ("endnote", "figure", "scene_break"):
        return [value]
    return [atom for child in value.get("content", []) for atom in atoms(child)]


def verify_reader_copy(books: Path, fixture: dict, *, edited: bool) -> None:
    db = books / f"{fixture['book_id']}.db"
    # The generated fixture is checkpointed and mounted read-only; pulled saves
    # may still have a WAL and must be read with its normal recovery semantics.
    target = f"{db.as_uri()}?mode=ro&immutable=1" if not edited else str(db)
    with closing(sqlite3.connect(target, uri=not edited)) as connection:
        if connection.execute("PRAGMA user_version").fetchone()[0] != fixture["schema"]:
            raise RuntimeError("reader changed user_version")
        body = json.loads(connection.execute("SELECT body FROM doc WHERE item_id=?", (fixture["scene_id"],)).fetchone()[0])
        if atoms(body) != atoms(fixture["body"]):
            raise RuntimeError("reader changed atom payloads, order or multiplicity")
        if edited and "ReaderEdit18" not in json.dumps(body):
            raise RuntimeError("surrounding prose edit was not saved")
        columns = ("id", "stored_name", "mime", "bytes", "sha256", "width_px", "height_px", "orientation")
        actual = [dict(zip(columns, row)) for row in connection.execute(f"SELECT {', '.join(columns)} FROM figure_asset ORDER BY id")]
        if sorted(actual, key=lambda asset: asset["id"]) != sorted(fixture["assets"], key=lambda asset: asset["id"]):
            raise RuntimeError("reader changed figure registry")
    for asset in fixture["assets"]:
        original = db.with_suffix(".pictures") / asset["stored_name"]
        if original.stat().st_size != asset["bytes"] or hashlib.sha256(original.read_bytes()).hexdigest() != asset["sha256"]:
            raise RuntimeError("reader changed figure original")


def reader_smoke(out: Path, source: Path, steps: list[str]) -> None:
    fixture = json.loads((source / "fixture.json").read_text())
    verify_reader_copy(source / "books", fixture, edited=False)
    adb("shell", "am", "force-stop", PKG)
    adb("root")
    adb("wait-for-device")
    roots = adb("shell", "find", f"/data/user/0/{PKG}", "-type", "d", "-name", "books").splitlines()
    if len(roots) != 1:
        raise RuntimeError(f"expected one fresh app book directory, found {roots}")
    remote = roots[0].strip()
    uid = adb("shell", "stat", "-c", "%u", f"/data/user/0/{PKG}").strip()
    if not uid.isdecimal():
        raise RuntimeError("app UID unavailable")
    adb("push", f"{source / 'books'}/.", remote)
    adb("shell", "chown", "-R", f"{uid}:{uid}", remote)
    adb("shell", "restorecon", "-R", remote)
    steps.append("verified schema-18 transferred copy seeded into fresh emulator")
    adb("shell", "am", "start", "-n", f"{PKG}/.MainActivity")
    nodes = checkpoint(out, "reader18-library", fixture["title"])
    tap_text(nodes, fixture["title"], out=out)
    nodes = checkpoint(out, "reader18-prose", "Surrounding prose")
    tap_text(nodes, "Read endnote 1", "Endnote 1 lesen", out=out)
    checkpoint(out, "reader18-note", "Retained note")
    nodes = hierarchy(out, "reader18-note-open")
    tap_text(nodes, "Read endnote 1", "Endnote 1 lesen", out=out)
    nodes = wait_nodes(out, "reader18-figure", lambda found: any(
        node.get("class") == "android.widget.Image" and "Retained alternative" in node_text(node)
        for node in found), 45)
    if not has(nodes, "Retained caption") or not has(nodes, "* * *"):
        raise RuntimeError("figure caption or scene break is not displayed")
    screenshot(out, "reader18-displayed")
    steps.append("native endnote body, loaded figure, caption and scene break displayed")
    tap_editable(nodes)
    # Android MOVE_HOME selects a safe prose position without touching an atom.
    adb("shell", "input", "keyevent", "KEYCODE_MOVE_HOME")
    type_token("ReaderEdit18")
    checkpoint(out, "reader18-edited", "ReaderEdit18")
    checkpoint(out, "reader18-saved", "Saved on this device", "Auf diesem Gerät gespeichert")
    adb("shell", "input", "keyevent", "KEYCODE_BACK")
    adb("shell", "input", "keyevent", "KEYCODE_HOME")
    adb("shell", "am", "force-stop", PKG)
    pulled = out / "reader18-after"
    adb("pull", remote, str(pulled))
    verify_reader_copy(pulled, fixture, edited=True)
    steps.append("saved database remains schema 18 with exact atoms, registry and original")
    adb("shell", "am", "start", "-n", f"{PKG}/.MainActivity")
    nodes = checkpoint(out, "reader18-reopened-library", fixture["title"])
    tap_text(nodes, fixture["title"], out=out)
    nodes = checkpoint(out, "reader18-reopened-prose", "ReaderEdit18")
    tap_text(nodes, "Read endnote 1", "Endnote 1 lesen", out=out)
    checkpoint(out, "reader18-reopened-note", "Retained note")
    steps.append("surrounding edit and endnote survived process death and reopen")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("evidence", type=Path)
    parser.add_argument("--reader-fixture", type=Path, help="reader-fixture output directory (fresh emulator only)")
    args = parser.parse_args()
    if not Path("/.dockerenv").is_file():
        parser.error("run in the isolated garret-android-emulator Docker container")
    apk = args.apk.resolve(strict=True)
    out = args.evidence.resolve()
    out.mkdir(parents=True, exist_ok=True)
    if not apk.is_file():
        parser.error("APK is not a regular file")
    with apk.open("rb") as file:
        digest = hashlib.file_digest(file, "sha256").hexdigest()
    nonce = digest[:8]
    book = f"Smoke227{nonce}"
    first = f"First227{nonce}"
    second_title = f"Second227{nonce}"
    second = f"SecondText227{nonce}"
    result: dict[str, object] = {"apk_sha256": digest,
                                 "package": PKG, "system_image": IMAGE, "steps": [], "status": "FAIL"}
    steps: list[str] = result["steps"]  # type: ignore[assignment]
    with tempfile.TemporaryDirectory(prefix="write227-") as temporary:
        temp = Path(temporary)
        env = os.environ.copy()
        env["ANDROID_AVD_HOME"] = str(temp / "avd")
        env["ANDROID_USER_HOME"] = str(temp / "android-user")
        Path(env["ANDROID_AVD_HOME"]).mkdir()
        Path(env["ANDROID_USER_HOME"]).mkdir()
        emulator = None
        try:
            run("avdmanager", "create", "avd", "-n", "write227", "-k", IMAGE,
                "--device", "pixel_6", "--force", env=env, timeout=90, answer="no\n")
            with (out / "emulator.log").open("w") as log:
                emulator = subprocess.Popen(("emulator", "@write227", "-no-window", "-no-audio",
                    "-no-boot-anim", "-no-snapshot", "-no-snapshot-save", "-gpu", "software",
                    "-memory", "3072", "-cores", "8", "-port", "5554"), env=env, stdout=log, stderr=subprocess.STDOUT)
            adb("wait-for-device", timeout=180)
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                if adb("shell", "getprop", "sys.boot_completed").strip() == "1":
                    break
                if emulator.poll() is not None:
                    raise RuntimeError(f"emulator exited early ({emulator.returncode})")
                time.sleep(2)
            else:
                raise RuntimeError("emulator did not finish booting")
            result["emulator_version"] = run("emulator", "-version", env=env).splitlines()[0]
            result["android_release"] = adb("shell", "getprop", "ro.build.version.release").strip()
            result["android_api"] = adb("shell", "getprop", "ro.build.version.sdk").strip()
            steps.append("fresh API 36 emulator booted")
            adb("install", "-r", str(apk), timeout=120)
            adb("shell", "am", "start", "-n", f"{PKG}/.MainActivity")
            nodes = checkpoint(out, "01-library", "Your books", "Deine Bücher")
            steps.append("APK installed; book library rendered")

            if args.reader_fixture:
                reader_smoke(out, args.reader_fixture.resolve(strict=True), steps)
                result["status"] = "PASS"
                return 0

            tap_editable(nodes)
            type_token(book)
            nodes = hierarchy(out, "02-book-title")
            tap_text(nodes, "Create book", "Buch erstellen", out=out)
            nodes = checkpoint(out, "03-created-book", "Outline", "Gliederung")
            steps.append("book created and opened")
            tap_editable(nodes)
            type_token(first)
            checkpoint(out, "04-first-text", first)
            checkpoint(out, "05-first-saved", "Saved on this device", "Auf diesem Gerät gespeichert")
            steps.append("first scene text entered and saved")

            nodes = hierarchy(out, "06-before-outline")
            tap_text(nodes, "Outline", "Gliederung", out=out)
            nodes = checkpoint(out, "07-outline", "Add scene", "Szene hinzufügen")
            tap_editable(nodes, last=True)
            type_token(second_title)
            nodes = hierarchy(out, "08-scene-title")
            tap_text(nodes, "Add scene", "Szene hinzufügen", out=out)
            nodes = checkpoint(out, "09-created-scene", second_title)
            steps.append("second scene created and selected")
            tap_editable(nodes)
            type_token(second)
            checkpoint(out, "10-second-text", second)
            checkpoint(out, "11-second-saved", "Saved on this device", "Auf diesem Gerät gespeichert")
            nodes = hierarchy(out, "12-second-outline-ready")
            tap_text(nodes, "Outline", "Gliederung", out=out)
            nodes = checkpoint(out, "13-scene-switch", "Scene 1", "Szene 1")
            tap_text(nodes, "Scene 1", "Szene 1", out=out, scene=True)
            checkpoint(out, "14-first-scene-restored", first)
            steps.append("scene switch restored first scene text")

            adb("shell", "input", "keyevent", "KEYCODE_HOME")
            time.sleep(3)
            adb("shell", "am", "force-stop", PKG)
            steps.append("app backgrounded and force-stopped")
            adb("shell", "am", "start", "-n", f"{PKG}/.MainActivity")
            nodes = checkpoint(out, "15-reopened-library", book)
            tap_text(nodes, book, out=out)
            checkpoint(out, "16-reopened-first", first)
            nodes = hierarchy(out, "17-reopened-outline-ready")
            tap_text(nodes, "Outline", "Gliederung", out=out)
            nodes = checkpoint(out, "18-reopened-scenes", second_title)
            tap_text(nodes, second_title, out=out, scene=True)
            checkpoint(out, "19-reopened-second", second)
            steps.append("both scenes and text survived process death and reopen")
            result["status"] = "PASS"
            return 0
        except Exception as error:
            result["failure"] = str(error)
            try:
                screenshot(out, "failure")
                hierarchy(out, "failure")
                (out / "logcat-tail.txt").write_text(adb("logcat", "-d", "-t", "500"))
                pid = adb("shell", "pidof", PKG).strip()
                if pid:
                    (out / "app-logcat.txt").write_text(adb("logcat", "-d", "--pid", pid))
                root_reply = adb("root", timeout=20)
                (out / "adb-root.txt").write_text(root_reply)
                adb("wait-for-device", timeout=30)
                (out / "app-files.txt").write_text(adb("shell", "ls", "-lR", f"/data/user/0/{PKG}"))
            except Exception:
                pass
            return 1
        finally:
            (out / "result.json").write_text(json.dumps(result, indent=2) + "\n")
            if emulator is not None:
                try:
                    adb("emu", "kill", timeout=10)
                except Exception:
                    pass
                emulator.terminate()
                try:
                    emulator.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    emulator.kill()


if __name__ == "__main__":
    raise SystemExit(main())
