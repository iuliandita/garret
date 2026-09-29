#!/usr/bin/env python3
"""Apply reproducible private-preview settings after Tauri Android generation."""
from pathlib import Path
import shutil
import xml.etree.ElementTree as ET

source = Path(__file__).resolve().parent
repo = source.parent.parent
android = repo / "app/shell-tauri/src-tauri/gen/android"
main = android / "app/src/main"
namespace = "http://schemas.android.com/apk/res/android"
ET.register_namespace("android", namespace)
manifest = main / "AndroidManifest.xml"
tree = ET.parse(manifest)
application = tree.getroot().find("application")
if application is None:
    raise SystemExit("generated Android manifest has no application")
application.set(f"{{{namespace}}}allowBackup", "false")
application.set(f"{{{namespace}}}fullBackupContent", "false")
application.set(f"{{{namespace}}}dataExtractionRules", "@xml/data_extraction_rules")
activity = application.find("activity")
if activity is None or activity.get(f"{{{namespace}}}name") != ".MainActivity":
    raise SystemExit("generated Android main activity changed")
activity.set(f"{{{namespace}}}windowSoftInputMode", "adjustResize")
ET.indent(tree, space="    ")
tree.write(manifest, encoding="utf-8", xml_declaration=True)

rules = ET.Element("data-extraction-rules")
for kind in ("cloud-backup", "device-transfer"):
    section = ET.SubElement(rules, kind)
    for domain in ("root", "file", "database", "sharedpref", "external",
                   "device_root", "device_file", "device_database", "device_sharedpref"):
        ET.SubElement(section, "exclude", {"domain": domain, "path": "."})
ET.indent(rules, space="    ")
ET.ElementTree(rules).write(main / "res/xml/data_extraction_rules.xml", encoding="utf-8", xml_declaration=True)
for name in ("MainActivity.kt", "TransferPlugin.kt"):
    shutil.copyfile(source / name, main / "java/cc/local/app" / name)
# Launcher icons come from scripts/render-icons, not the generator's defaults.
launchers = repo / "app/shell-tauri/src-tauri/icons/android"
for icon in sorted(launchers.glob("mipmap-*/*.png")):
    target = main / "res" / icon.parent.name / icon.name
    if not target.is_file():
        raise SystemExit(f"generated Android resources have no {icon.parent.name}/{icon.name}")
    shutil.copyfile(icon, target)

properties = android / "gradle.properties"
lines = properties.read_text().splitlines()
settings = {"org.gradle.workers.max": "8", "org.gradle.parallel": "false", "org.gradle.daemon": "false"}
lines = [line for line in lines if line.partition("=")[0] not in settings]
properties.write_text("\n".join([*lines, *(f"{key}={value}" for key, value in settings.items())]) + "\n")
task = android / "buildSrc/src/main/java/cc/local/app/kotlin/BuildTask.kt"
task_source = task.read_text()
generated = 'listOf("tauri", "android", "android-studio-script")'
container_cli = 'listOf("/usr/local/bin/tauri", "android", "android-studio-script")'
if generated not in task_source and container_cli not in task_source:
    raise SystemExit("generated Tauri build command changed")
task.write_text(task_source.replace(generated, container_cli))
print("Prepared Android preview: local data, bounded builds, lifecycle and keyboard handling")
