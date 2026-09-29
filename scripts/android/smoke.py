#!/usr/bin/env python3
"""Fresh headless Android book/edit/reopen smoke check. Run inside write-android-emulator."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET


PKG = "cc.local.app"
IMAGE = "system-images;android-36;google_apis;x86_64"
BOUNDS = re.compile(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]")


def run(*args: str, env: dict[str, str] | None = None, timeout: int = 30,
        answer: str | None = None) -> str:
    done = subprocess.run(args, env=env, text=True, capture_output=True,
                          input=answer, timeout=timeout)
    if done.returncode:
        raise RuntimeError(f"{args[0]} {args[1:]} failed ({done.returncode}): {done.stderr[-1500:]}")
    return done.stdout


def adb(*args: str, timeout: int = 30) -> str:
    return run("adb", *args, timeout=timeout)


def screenshot(out: Path, name: str) -> None:
    with (out / f"{name}.png").open("wb") as file:
        done = subprocess.run(("adb", "exec-out", "screencap", "-p"), stdout=file, stderr=subprocess.PIPE, timeout=30)
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


def tap_text(nodes: list[ET.Element], *texts: str) -> None:
    for node in nodes:
        if any(text == node.attrib.get("text") or text == node.attrib.get("content-desc") for text in texts):
            tap_node(node)
            return
    raise RuntimeError(f"UI control missing: {texts}")


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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("evidence", type=Path)
    args = parser.parse_args()
    if not Path("/.dockerenv").is_file():
        parser.error("run in the isolated write-android-emulator Docker container")
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
                    "-memory", "3072"), env=env, stdout=log, stderr=subprocess.STDOUT)
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

            tap_editable(nodes)
            type_token(book)
            nodes = hierarchy(out, "02-book-title")
            tap_text(nodes, "Create book", "Buch erstellen")
            nodes = checkpoint(out, "03-created-book", "Outline", "Gliederung")
            steps.append("book created and opened")
            tap_editable(nodes)
            type_token(first)
            checkpoint(out, "04-first-text", first)
            checkpoint(out, "05-first-saved", "Saved on this device", "Auf diesem Gerät gespeichert")
            steps.append("first scene text entered and saved")

            nodes = hierarchy(out, "06-before-outline")
            tap_text(nodes, "Outline", "Gliederung")
            nodes = checkpoint(out, "07-outline", "Add scene", "Szene hinzufügen")
            tap_editable(nodes, last=True)
            type_token(second_title)
            nodes = hierarchy(out, "08-scene-title")
            tap_text(nodes, "Add scene", "Szene hinzufügen")
            nodes = checkpoint(out, "09-created-scene", second_title)
            steps.append("second scene created and selected")
            tap_editable(nodes)
            type_token(second)
            checkpoint(out, "10-second-text", second)
            checkpoint(out, "11-second-saved", "Saved on this device", "Auf diesem Gerät gespeichert")
            nodes = hierarchy(out, "12-second-outline-ready")
            tap_text(nodes, "Outline", "Gliederung")
            nodes = checkpoint(out, "13-scene-switch", "Scene 1", "Szene 1")
            tap_text(nodes, "Scene 1", "Szene 1")
            checkpoint(out, "14-first-scene-restored", first)
            steps.append("scene switch restored first scene text")

            adb("shell", "input", "keyevent", "KEYCODE_HOME")
            time.sleep(3)
            adb("shell", "am", "force-stop", PKG)
            steps.append("app backgrounded and force-stopped")
            adb("shell", "am", "start", "-n", f"{PKG}/.MainActivity")
            nodes = checkpoint(out, "15-reopened-library", book)
            tap_text(nodes, book)
            checkpoint(out, "16-reopened-first", first)
            nodes = hierarchy(out, "17-reopened-outline-ready")
            tap_text(nodes, "Outline", "Gliederung")
            nodes = checkpoint(out, "18-reopened-scenes", second_title)
            tap_text(nodes, second_title)
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
