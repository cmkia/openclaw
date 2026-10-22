#!/usr/bin/env python3
"""Live HTTP proof for the private library; uses only synthetic documents.

Run against an isolated verification database or explicitly approved client.
The fixture documents are retained as evidence; this script never deletes data.
Credentials are read from a file or environment and never written to the report.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def pdf_bytes(pages: list[list[tuple[int, str]]], bookmarks: bool = False) -> bytes:
    """Make a real, small PDF with independent page/chapter expectations."""
    objects: list[bytes] = []

    def add(value: bytes) -> int:
        objects.append(value)
        return len(objects)

    def literal(text: str) -> str:
        return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

    catalog = add(b"")
    tree = add(b"")
    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    page_ids: list[int] = []
    for lines in pages:
        commands = ["BT"]
        y = 740
        for size, line in lines:
            commands.extend([f"/F1 {size} Tf", f"1 0 0 1 54 {y} Tm", f"({literal(line)}) Tj"])
            y -= max(22, size + 10)
        commands.append("ET")
        content = "\n".join(commands).encode("ascii")
        stream = add(f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"\nendstream")
        page_ids.append(add(
            f"<< /Type /Page /Parent {tree} 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 {font} 0 R >> >> /Contents {stream} 0 R >>".encode()
        ))
    objects[tree - 1] = (
        f"<< /Type /Pages /Count {len(page_ids)} /Kids ["
        + " ".join(f"{page} 0 R" for page in page_ids) + "] >>"
    ).encode()
    outline_entry = ""
    if bookmarks:
        outline = add(b"")
        first = add(b"")
        second = add(b"")
        objects[outline - 1] = f"<< /Type /Outlines /First {first} 0 R /Last {second} 0 R /Count 2 >>".encode()
        objects[first - 1] = (
            f"<< /Title (Chapter 1 - Beam treatment) /Parent {outline} 0 R "
            f"/Next {second} 0 R /Dest [{page_ids[0]} 0 R /Fit] >>"
        ).encode()
        objects[second - 1] = (
            f"<< /Title (Chapter 2 - Imaging workflow) /Parent {outline} 0 R "
            f"/Prev {first} 0 R /Dest [{page_ids[2]} 0 R /Fit] >>"
        ).encode()
        outline_entry = f" /Outlines {outline} 0 R"
    objects[catalog - 1] = f"<< /Type /Catalog /Pages {tree} 0 R{outline_entry} >>".encode()
    output = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for number, value in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(f"{number} 0 obj\n".encode() + value + b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        output.extend(f"{offset:010} 00000 n \n".encode())
    output.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root {catalog} 0 R >>\n"
        f"startxref\n{xref}\n%%EOF\n".encode()
    )
    return bytes(output)


def chapter_fixture(nonce: str) -> bytes:
    return pdf_bytes([
        [
            (19, "Chapter 1 - Beam treatment"),
            (15, "1.1 Energy delivery"),
            (11, "External beam radiotherapy delivers radiation from a machine"),
            (11, "outside the body toward the tumor. This educational fixture"),
            (11, "uses the fictional training label AURORA-BEAM for that technique."),
            (11, "The original source must be checked before any clinical use."),
            (10, f"Synthetic verification document {nonce}. Page 1."),
        ],
        [
            (15, "1.2 Protecting nearby organs"),
            (11, "Treatment planning considers nearby healthy tissues and organs."),
            (11, "The fictional review label HARBOR-SHIELD refers to organ protection."),
            (11, "This section contains no numerical treatment recommendation."),
            (10, f"Synthetic verification document {nonce}. Page 2."),
        ],
        [
            (19, "Chapter 2 - Imaging workflow"),
            (15, "2.1 Position verification"),
            (11, "Image guidance checks patient positioning before delivery."),
            (11, "The fictional workflow label ORBIT-VERIFY belongs to this chapter."),
            (11, "It must not be included when retrieving only Chapter 1."),
            (10, f"Synthetic verification document {nonce}. Page 3."),
        ],
    ], bookmarks=True)


class VerificationFailure(Exception):
    pass


class Client:
    def __init__(self, base_url: str, key: str, timeout: float):
        self.base_url = base_url.rstrip("/")
        self.key = key
        self.timeout = timeout

    def request(self, method: str, path: str, body=None, *, auth=True,
                expected=(200,), raw=False, invalid_key=False):
        headers = {}
        if auth:
            headers["Authorization"] = "Bearer " + ("invalid-verification-key" if invalid_key else self.key)
        if isinstance(body, bytes):
            headers["Content-Type"] = "application/pdf"
        elif body is not None:
            body = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base_url + path, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                status, data = response.status, response.read()
        except urllib.error.HTTPError as error:
            status, data = error.code, error.read()
        except (urllib.error.URLError, TimeoutError) as error:
            raise VerificationFailure(f"Transport failure on {method} {path.split('?')[0]}: {type(error).__name__}") from None
        if status not in expected:
            raise VerificationFailure(f"{method} {path.split('?')[0]} returned HTTP {status}; expected {expected}")
        if raw:
            return data
        if not data:
            return None
        try:
            return json.loads(data)
        except ValueError:
            raise VerificationFailure(f"Non-JSON response from {method} {path.split('?')[0]}") from None


def require(condition: bool, reason: str):
    if not condition:
        raise VerificationFailure(reason)


def wait_job(client: Client, job_id: str, timeout: float) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        job = client.request("GET", f"/v1/jobs/{urllib.parse.quote(job_id)}")
        if job.get("status") in {"completed", "failed"}:
            require(job["status"] == "completed", "Synthetic document processing failed; inspect the authenticated job diagnostics")
            return job
        require(time.monotonic() < deadline, "Document processing did not finish within the verification deadline")
        time.sleep(2)


def chapter_name(chapters: list[dict], token: str) -> str:
    matching = [entry["chapter"] for entry in chapters if token in entry["chapter"].lower()]
    require(len(matching) == 1, f"Expected one chapter matching {token!r}")
    return matching[0]


def inspect_document(client: Client, fixture: dict, report: dict):
    document_id = fixture["document_id"]
    client.request("GET", f"/v1/documents/{document_id}/original", auth=False, expected=(401,))
    content = client.request("GET", f"/v1/documents/{document_id}/original", raw=True)
    require(hashlib.sha256(content).hexdigest() == fixture["sha256"], "Original download bytes changed or another document was returned")
    report["checks"].append("authenticated_original_integrity")
    result = client.request("GET", f"/v1/chapters/{document_id}")
    document_status = result["document"]["status"]
    require(document_status in {"ready", "pending_review"}, "Structured textbook has no usable extraction; inspect chapter diagnostics")
    needs_review = document_status == "pending_review"
    if needs_review:
        require(bool(result["document"]["review_reason"]), "Uncertain structure has no actionable review reason")
        report["checks"].append("inferred_structure_has_explicit_review_warning")
    chapter_one = chapter_name(result["chapters"], "beam")
    chapter_two = chapter_name(result["chapters"], "imaging")
    coverage = client.request("GET", f"/v1/coverage/{document_id}?" + urllib.parse.urlencode({"chapter": chapter_one}))
    require(coverage["requires_full_section_read"] is True, "Chapter planning did not declare full-section reading")
    require(coverage["needs_review"] == needs_review, "Chapter coverage lost the document's extraction review state")
    sections = coverage["sections"]
    require(any("energy" in item["section"].lower() for item in sections), "Chapter coverage omitted the energy-delivery section")
    require(any("protect" in item["section"].lower() for item in sections), "Chapter coverage omitted the organ-protection section")
    expected_pages = {1, 2}
    seen_pages: set[int] = set()
    full_text = []
    for section in sections:
        offset = 0
        while True:
            page = client.request("GET", f"/v1/sections/{document_id}?" + urllib.parse.urlencode({
                "chapter": chapter_one, "section": section["section"], "offset": offset, "limit": 1,
            }))
            require(bool(page["results"]), "Full chapter read returned an empty page before completion")
            for evidence in page["results"]:
                require(evidence["chapter"] == chapter_one, "Chapter read leaked another chapter")
                require(evidence["section"] == section["section"], "Section read returned a different section")
                seen_pages.update(range(evidence["page_start"], evidence["page_end"] + 1))
                full_text.append(evidence["text"])
            if page["next_offset"] is None:
                break
            require(page["next_offset"] > offset, "Section pagination did not advance")
            offset = page["next_offset"]
    text = " ".join(full_text)
    require("AURORA-BEAM" in text and "HARBOR-SHIELD" in text, "Full chapter read omitted independent section evidence")
    require("ORBIT-VERIFY" not in text and seen_pages == expected_pages, "Chapter scope or original page attribution was incorrect")
    report["checks"].append("whole_chapter_coverage_and_original_pages")
    query = client.request("POST", "/v1/search", {
        "query": "Como a radiacao chega ao tumor a partir de um equipamento fora do corpo?",
        "document_id": document_id, "chapter": chapter_one, "limit": 4,
    })
    require(query.get("retrieval", {}).get("mode") == "hybrid", "Search did not use both lexical and real semantic retrieval")
    require(bool(query.get("retrieval", {}).get("embedding_model")), "Search did not identify its real embedding model")
    require(query.get("abstain") is False and bool(query["results"]), "Portuguese question did not retrieve English source evidence")
    require(any("AURORA-BEAM" in item["text"] for item in query["results"]), "Cross-language search did not retrieve the independent expected passage")
    for evidence in query["results"]:
        require(evidence["document_id"] == document_id and evidence["chapter"] == chapter_one, "Search escaped the requested document/chapter scope")
        require(evidence["edition"] == fixture["edition"], "Evidence lost edition provenance")
        require(bool(evidence["evidence_id"]), "Search evidence has no citation identifier")
        require(evidence["original_url"].startswith(f"/v1/documents/{document_id}/original#page="), "Citation does not point to this original document")
        require(evidence["page_start"] in expected_pages and evidence["page_end"] in expected_pages, "Citation escaped the chapter's original pages")
        require(evidence["needs_review"] == needs_review, "Search lost the document's extraction review state")
        require(evidence["extraction_status"] == document_status, "Search evidence has inconsistent extraction status")
    report["checks"].append("real_multilingual_hybrid_retrieval_and_citations")
    second = client.request("POST", "/v1/search", {
        "query": "ORBIT-VERIFY", "document_id": document_id, "chapter": chapter_two, "limit": 3,
    })
    require(any("ORBIT-VERIFY" in item["text"] for item in second["results"]), "Second chapter's lexical sentinel was not retrievable")
    require(all(item["chapter"] == chapter_two and item["page_start"] == 3 for item in second["results"]), "Second chapter search has invalid scope or page provenance")
    absent = client.request("POST", "/v1/search", {
        "query": "oceanic volcanic geology and lunar ceramic mining economics",
        "document_id": document_id, "chapter": chapter_one, "limit": 4,
    })
    require(absent.get("abstain") is True, "Unrelated question was not marked as insufficient evidence")
    report["checks"].append("irrelevant_question_abstention")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=os.environ.get("LIBRARY_BASE_URL", "http://127.0.0.1:8080"))
    parser.add_argument("--key-file", default=os.environ.get("LIBRARY_API_KEY_FILE"))
    parser.add_argument("--request-timeout", type=float, default=120)
    parser.add_argument("--document-timeout", type=float, default=1200)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--resume-report", type=Path, help="Recheck persisted evidence after an operator-controlled API/worker restart")
    args = parser.parse_args()
    key = Path(args.key_file).read_text().strip() if args.key_file else os.environ.get("LIBRARY_API_KEY", "").strip()
    if not key:
        parser.error("Set LIBRARY_API_KEY_FILE, --key-file, or LIBRARY_API_KEY")
    client = Client(args.base_url, key, args.request_timeout)
    report = {
        "passed": False, "checks": [], "fixture": None,
        "limits": [
            "Synthetic academic text only; no clinical accuracy claim.",
            "A separate operator-controlled worker restart is required to prove interrupted-job recovery.",
            "Drive folder rejection proves API scope enforcement, not an OAuth-backed live Drive listing.",
            "Real scanned chapters and numerical tables require separate OCR/source comparison.",
        ],
    }
    started = time.monotonic()
    try:
        client.request("GET", "/healthz", auth=False)
        client.request("GET", "/v1/documents", auth=False, expected=(401,))
        client.request("GET", "/v1/documents", invalid_key=True, expected=(401,))
        report["checks"].append("unauthenticated_and_incorrect_key_rejected")
        client.request("POST", "/v1/import/url", {
            "url": "http://127.0.0.1/private.pdf", "title": "Rejected local URL",
        }, expected=(400, 422))
        report["checks"].append("private_network_url_rejected")
        client.request("POST", "/v1/drive/sync", {"folder_id": "foreign-verification-folder"}, expected=(400, 422))
        report["checks"].append("drive_folder_override_rejected")
        if args.resume_report:
            previous = json.loads(args.resume_report.read_text())
            fixture = previous["fixture"]
            require(bool(fixture), "Previous report has no imported fixture")
            report["fixture"] = fixture
            wait_job(client, fixture["job_id"], args.document_timeout)
            inspect_document(client, fixture, report)
            report["checks"].append("evidence_survives_operator_controlled_restart")
        else:
            nonce = secrets.token_hex(6)
            pdf = chapter_fixture(nonce)
            edition = "Synthetic verification edition " + nonce
            upload_path = "/v1/import/upload?" + urllib.parse.urlencode({
                "title": "Synthetic chapter verification " + nonce, "edition": edition,
                "filename": "synthetic-chapters.pdf",
            })
            imported = client.request("POST", upload_path, pdf, expected=(200, 201, 202))
            fixture = {
                "document_id": imported["document_id"], "job_id": imported["job_id"],
                "sha256": hashlib.sha256(pdf).hexdigest(), "edition": edition,
            }
            report["fixture"] = fixture
            duplicate = client.request("POST", upload_path, pdf, expected=(200, 201, 202))
            require(duplicate.get("duplicate") is True and duplicate["document_id"] == fixture["document_id"], "Identical upload was not deduplicated")
            report["checks"].append("original_bytes_deduplicated")
            wait_job(client, fixture["job_id"], args.document_timeout)
            inspect_document(client, fixture, report)
            uncertain_pdf = pdf_bytes([[
                (11, "This synthetic text deliberately contains no chapter markers."),
                (11, "The library must expose the uncertain structure for review."),
                (11, f"Unstructured verification document {nonce}."),
            ]])
            uncertain = client.request("POST", "/v1/import/upload?" + urllib.parse.urlencode({
                "title": "Unstructured verification " + nonce, "filename": "unstructured.pdf",
            }), uncertain_pdf, expected=(200, 201, 202))
            job = wait_job(client, uncertain["job_id"], args.document_timeout)
            require(job.get("document_status") == "pending_review", "Uncertain chapter extraction was silently admitted as ready")
            uncertain_results = client.request("POST", "/v1/search", {
                "query": "synthetic", "document_id": uncertain["document_id"], "limit": 3,
            })
            require(bool(uncertain_results["results"]), "Uncertain extraction was not available for explicit review")
            require(all(item["needs_review"] is True and item["extraction_status"] == "pending_review"
                        for item in uncertain_results["results"]), "Uncertain source evidence lost its review warning")
            report["checks"].append("uncertain_structure_requires_review")
        report["passed"] = True
    except (VerificationFailure, KeyError, TypeError, ValueError, OSError) as error:
        report["failure"] = str(error) if isinstance(error, VerificationFailure) else f"Verification contract error: {type(error).__name__}"
    report["elapsed_seconds"] = round(time.monotonic() - started, 2)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"passed": report["passed"], "checks": report["checks"], "report": str(args.report), "failure": report.get("failure")}))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
