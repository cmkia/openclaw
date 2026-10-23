#!/usr/bin/env python3
"""Opt-in, synthetic production-path MCP proof; never logs credentials or content."""

import argparse
import hashlib
import json
import math
from pathlib import Path
import posixpath
import sys
import urllib.error
import urllib.request
import uuid
import xml.etree.ElementTree as ET
import zipfile


class Probe:
    def __init__(self, url, key):
        self.url = url.rstrip("/")
        self.key = key
        self.sequence = 0
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(self, method, params=None, authenticated=True, notification=False):
        self.sequence += 1
        payload = {"jsonrpc": "2.0", "method": method}
        if not notification:
            payload["id"] = self.sequence
        if params is not None:
            payload["params"] = params
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if authenticated:
            headers["Authorization"] = "Bearer " + self.key
        req = urllib.request.Request(
            self.url, data=json.dumps(payload).encode(), headers=headers, method="POST"
        )
        try:
            with self.opener.open(req, timeout=240) as response:
                status = response.status
                body = response.read().decode()
                content_type = response.headers.get("Content-Type", "")
        except urllib.error.HTTPError as error:
            return error.code, None
        if not body:
            return status, None
        if "text/event-stream" in content_type:
            messages = [json.loads(line[5:]) for line in body.splitlines() if line.startswith("data:")]
            matches = [item for item in messages if item.get("id") == payload.get("id")]
            if not matches:
                raise AssertionError("SSE response did not contain the request result")
            return status, matches[-1]
        return status, json.loads(body)

    def rpc(self, method, params=None):
        status, message = self.request(method, params)
        if status != 200 or not isinstance(message, dict) or "error" in message:
            raise AssertionError(f"MCP {method} failed (HTTP {status})")
        return message["result"]

    def tool(self, name, arguments):
        return self.rpc("tools/call", {"name": name, "arguments": arguments})


def tool_json(result):
    text = "\n".join(block["text"] for block in result.get("content", []) if block.get("type") == "text")
    if result.get("isError"):
        raise AssertionError("MCP tool returned an error: " + text[:1200])
    return json.loads(text)


def require_tool_rejection(result):
    if not result.get("isError"):
        raise AssertionError("Rejected tool input returned success")


def files_fingerprint(folder):
    return {
        str(path.relative_to(folder)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(folder.rglob("*")) if path.is_file()
    }


def workspace_file(workspace, relative):
    path = (workspace / relative).resolve()
    if not path.is_relative_to(workspace):
        raise AssertionError("Tool returned an artifact outside the workspace")
    if not path.is_file() or path.stat().st_size == 0:
        raise AssertionError("Expected nonempty artifact is missing")
    return path


def inspect_pptx(path, manifest):
    expected_slides = len(manifest["slides"])
    text_tag = "{http://schemas.openxmlformats.org/drawingml/2006/main}t"
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        slide_paths = [name for name in names if name.startswith("ppt/slides/slide") and name.endswith(".xml")]
        note_paths = [name for name in names if name.startswith("ppt/notesSlides/notesSlide") and name.endswith(".xml")]
        table_count = 0
        for name in slide_paths:
            root = ET.fromstring(archive.read(name))
            table_count += len(root.findall(".//{http://schemas.openxmlformats.org/drawingml/2006/main}tbl"))
        charts = [name for name in names if name.startswith(("ppt/charts/chart", "ppt/slides/charts/chart")) and name.endswith(".xml")]
        media = [name for name in names if name.startswith("ppt/media/")]
        note_texts = [
            "\n".join(item.text or "" for item in ET.fromstring(archive.read(name)).iter(text_tag)).strip()
            for name in note_paths
        ]
        counts = {"slides": len(slide_paths), "notes": len(note_paths), "nativeTables": table_count,
                  "nativeCharts": len(charts), "embeddedMedia": len(media)}
        if counts["slides"] != expected_slides or counts["notes"] != expected_slides:
            raise AssertionError("PPTX slide or speaker-note count differs from the pilot contract")
        if not all(note_texts) or not table_count or not charts or not media:
            raise AssertionError("PPTX must contain speaker notes, native table/chart and embedded media")
        for index, slide in enumerate(manifest["slides"], start=1):
            note = ET.fromstring(archive.read(f"ppt/notesSlides/notesSlide{index}.xml"))
            note_text = "\n".join(item.text or "" for item in note.iter(text_tag))
            required_text = [slide.get("notes", "")]
            for citation in slide.get("citations", []):
                required_text.extend([citation["source"], citation.get("locator", "")])
            if any(value and value not in note_text for value in required_text):
                raise AssertionError("Speaker notes or citation locator was lost in the PPTX")
            if slide.get("chart"):
                inspect_chart(archive, index, slide["chart"])
        return counts


def inspect_chart(archive, slide_number, expected):
    chart_ns = "http://schemas.openxmlformats.org/drawingml/2006/chart"
    drawing_ns = "http://schemas.openxmlformats.org/drawingml/2006/main"
    office_rel_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    package_rel_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
    ns = {"c": chart_ns, "a": drawing_ns}
    part = f"ppt/slides/slide{slide_number}.xml"
    slide = ET.fromstring(archive.read(part))
    refs = slide.findall(".//c:chart", ns)
    if len(refs) != 1:
        raise AssertionError("Chart slide must reference one editable chart")
    rid = refs[0].get("{" + office_rel_ns + "}id")
    relationships = ET.fromstring(archive.read(f"ppt/slides/_rels/slide{slide_number}.xml.rels"))
    targets = [item.get("Target") for item in relationships.findall("{" + package_rel_ns + "}Relationship") if item.get("Id") == rid]
    if len(targets) != 1:
        raise AssertionError("Chart relationship is unresolved")
    target = targets[0]
    chart_part = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join(posixpath.dirname(part), target))
    chart = ET.fromstring(archive.read(chart_part))

    def cache_values(root, expression):
        points = root.findall(expression, ns)
        return [point.find("c:v", ns).text for point in sorted(points, key=lambda item: int(item.get("idx")))]

    series = chart.findall(".//c:ser", ns)
    if len(series) != len(expected["series"]):
        raise AssertionError("Editable chart series count differs from the supplied data")
    for actual, wanted in zip(series, expected["series"]):
        category_values = (cache_values(actual, "c:cat/c:strRef/c:strCache/c:pt")
                           or cache_values(actual, "c:cat/c:strLit/c:pt")
                           or cache_values(actual, "c:cat/c:multiLvlStrRef/c:multiLvlStrCache/c:lvl/c:pt"))
        numbers = cache_values(actual, "c:val/c:numRef/c:numCache/c:pt") or cache_values(actual, "c:val/c:numLit/c:pt")
        names = cache_values(actual, "c:tx/c:strRef/c:strCache/c:pt")
        direct_name = actual.find("c:tx/c:v", ns)
        actual_name = names[0] if names else direct_name.text if direct_name is not None else None
        if actual_name != wanted["name"] or category_values != expected["categories"]:
            raise AssertionError("Editable chart series name or category labels differ from the supplied data")
        if len(numbers) != len(wanted["values"]) or any(
            not math.isclose(float(actual_number), expected_number, rel_tol=1e-12, abs_tol=1e-12)
            for actual_number, expected_number in zip(numbers, wanted["values"])
        ):
            raise AssertionError("Editable chart numeric values differ from the supplied data")
    x_title = "".join(item.text or "" for item in chart.findall(".//c:catAx/c:title//a:t", ns))
    y_title = "".join(item.text or "" for item in chart.findall(".//c:valAx/c:title//a:t", ns))
    if expected.get("xTitle") and expected["xTitle"] not in x_title:
        raise AssertionError("Editable chart is missing its supplied X-axis title")
    if any(expected.get(key) and expected[key] not in y_title for key in ("yTitle", "unit")):
        raise AssertionError("Editable chart is missing its supplied Y-axis title or unit")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--manifest-path", required=True)
    parser.add_argument("--workspace", required=True, type=Path, help="Host path of the MCP workspace mount")
    parser.add_argument("--output-prefix", required=True, type=Path, help="Local redacted proof JSON prefix")
    parser.add_argument("--expected-slides", type=int, default=8)
    parser.add_argument("--symlink-manifest")
    parser.add_argument("--invalid-manifest")
    args = parser.parse_args()
    workspace = args.workspace.resolve(strict=True)
    manifest = json.loads(workspace_file(workspace, args.manifest_path).read_text(encoding="utf-8"))
    if len(manifest["slides"]) != args.expected_slides:
        raise AssertionError("Pilot manifest does not have the requested slide count")
    probe = Probe(args.url, args.key_file.read_text().strip())
    status, _ = probe.request("initialize", {}, authenticated=False)
    if status not in (401, 403):
        raise AssertionError(f"Unauthenticated MCP access was not rejected (HTTP {status})")
    initialized = probe.rpc("initialize", {
        "protocolVersion": "2025-03-26", "capabilities": {},
        "clientInfo": {"name": "presentation-live-probe", "version": "1.0"},
    })
    probe.request("notifications/initialized", notification=True)
    tools = probe.rpc("tools/list")["tools"]
    tool_names = {item["name"] for item in tools}
    required = {"presentations_render", "presentations_check"}
    if not required.issubset(tool_names):
        raise AssertionError("Presentation MCP tools are missing")
    rejected_folder = "presentations/exports/probe-rejected-" + uuid.uuid4().hex
    for bad_path in ["/etc/passwd", "../outside.json", args.symlink_manifest, args.invalid_manifest]:
        if bad_path:
            rejected = probe.tool("presentations_render", {"manifestPath": bad_path, "outputDirectory": rejected_folder})
            require_tool_rejection(rejected)
            if (workspace / rejected_folder).exists():
                raise AssertionError("Rejected manifest left an output directory")
    rendered = tool_json(probe.tool("presentations_render", {"manifestPath": args.manifest_path}))
    relative = rendered["workspaceRelative"]
    pptx = workspace_file(workspace, relative["pptx"])
    pdf = workspace_file(workspace, relative["pdf"])
    validation = workspace_file(workspace, relative["validation"])
    pngs = [workspace_file(workspace, name) for name in relative["pngs"]]
    if len(pngs) != args.expected_slides:
        raise AssertionError("PNG preview count differs from the pilot contract")
    if not pdf.read_bytes().startswith(b"%PDF-"):
        raise AssertionError("PDF output is not a PDF")
    if any(not path.read_bytes().startswith(b"\x89PNG\r\n\x1a\n") for path in pngs):
        raise AssertionError("A preview output is not a PNG")
    counts = inspect_pptx(pptx, manifest)
    checked = tool_json(probe.tool("presentations_check", {"presentationPath": relative["pptx"]}))
    if checked.get("status") != "pass" or checked.get("findings"):
        raise AssertionError("Published presentation failed the public check tool")
    if json.loads(validation.read_text(encoding="utf-8")).get("status") != "pass":
        raise AssertionError("Published presentation validation report is not passing")
    destination = pptx.parent
    before = files_fingerprint(destination)
    overwrite = probe.tool("presentations_render", {
        "manifestPath": args.manifest_path,
        "outputDirectory": str(destination.relative_to(workspace)),
    })
    require_tool_rejection(overwrite)
    if files_fingerprint(destination) != before:
        raise AssertionError("Rejected overwrite changed published artifacts")
    report = {"status": "passed", "protocolVersion": initialized["protocolVersion"],
              "tools": sorted(required), "counts": counts, "previews": len(pngs),
              "checks": ["unauthorized", "path-boundary", "render", "package-xml", "pdf-png", "check-tool", "overwrite-preserves-artifacts"],
              "optionalNegativeChecks": {"symlink": bool(args.symlink_manifest), "invalidManifest": bool(args.invalid_manifest)},
              "artifactHashes": before}
    args.output_prefix.parent.mkdir(parents=True, exist_ok=True)
    args.output_prefix.with_suffix(".json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key != "artifactHashes"}))


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, KeyError, ValueError, OSError, ET.ParseError, zipfile.BadZipFile) as error:
        print(f"Presentation proof failed: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
