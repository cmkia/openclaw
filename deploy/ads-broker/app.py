"""Private MCP adapter to the existing read-only agency report owner."""

import hashlib
import hmac
import json
import math
import os
import re
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import Field, StrictInt
from starlette.responses import JSONResponse


MAX_BYTES = 16 * 1024 * 1024
ENDPOINT = "/webhook/agency-report-read-v1"
ARGUMENTS = {
    "ads_status": set(),
    "ads_contas": set(),
    "ads_relatorio": {"client_id", "dataset", "platform", "start", "end", "limit", "offset"},
}
TEXT_FIELDS = set("date platform account_id campaign_id campaign_name group_id group_name ad_id ad_name keyword_id keyword match_type click_definition conversion_definition video_view_definition currency_code time_zone status creative_id ad_type creative_titles creative_descriptions creative_body creative_text_definition campaign_status group_status keyword_status bidding_strategy_type keyword_effective_cpc_bid_source quality_creative quality_landing_page quality_expected_ctr".split())
NUMBER_FIELDS = set("impressions clicks cost conversions conversion_value video_views video_p25_watched video_p50_watched video_p75_watched video_p100_watched keyword_cpc_bid keyword_effective_cpc_bid quality_score".split())
METADATA_FIELDS = {"schema_version", "dataset", "start", "end", "client_id", "grain", "attribution", "coverage", "creative_metadata"}


def load_configuration():
    try:
        key = Path(os.environ["ADS_API_KEY_FILE"]).read_text().strip()
        credentials = json.loads(Path(os.environ["ADS_CREDENTIALS_FILE"]).read_text())
    except (OSError, ValueError, KeyError):
        raise RuntimeError("Mount ADS_API_KEY_FILE and ADS_CREDENTIALS_FILE with valid private configuration.") from None
    if len(key) < 32 or not isinstance(credentials, dict):
        raise RuntimeError("The broker key must contain at least 32 characters and credentials must be an object.")
    if not credentials:
        return key, "", "", {}
    url = credentials.get("report_url", "")
    token = credentials.get("collector_token", "")
    try:
        parsed = urlsplit(url)
        valid_url = parsed.scheme == "https" and parsed.hostname and parsed.path == ENDPOINT and not (
            parsed.username or parsed.password or parsed.query or parsed.fragment
        ) and parsed.port in (None, 443)
    except (ValueError, TypeError):
        valid_url = False
    if not valid_url or not isinstance(token, str) or len(token) < 20 or any(c.isspace() for c in token):
        raise RuntimeError("Configure a fixed HTTPS report endpoint and a valid collector credential.")
    entries = credentials.get("accounts")
    if not isinstance(entries, list) or len(entries) > 100:
        raise RuntimeError("Configure an explicit accounts list with at most 100 grants.")
    accounts = {}
    for entry in entries:
        if not isinstance(entry, dict) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", entry.get("client_id", "")):
            raise RuntimeError("Each account grant needs a valid client_id.")
        client_id = entry["client_id"]
        ids = {name: entry.get(name, "") for name in ("google_customer_id", "meta_account_id")}
        if client_id in accounts or not any(ids.values()) or any(
            not isinstance(value, str) or (value and not re.fullmatch(r"[0-9]{1,30}", value)) for value in ids.values()
        ):
            raise RuntimeError("Account grants must have unique client IDs and explicit numeric account IDs.")
        accounts[client_id] = {"client_id": client_id, **ids}
    return key, url, token, accounts


API_KEY, REPORT_URL, COLLECTOR_TOKEN, ACCOUNTS = load_configuration()
KEY_HASH = hashlib.sha256(API_KEY.encode()).digest()


def safe_text(value):
    if not isinstance(value, str):
        return None
    for secret in (COLLECTOR_TOKEN, API_KEY):
        if secret:
            value = value.replace(secret, "[redacted]")
    # Reports need no URLs: remove links rather than returning embedded credentials.
    return re.sub(r"https?://[^\s<>]+", "[link omitted]", value)[:4000]


def project(values, fields):
    return {key: safe_text(value) if isinstance(value, str) else value for key, value in values.items()
            if key in fields and (value is None or isinstance(value, (str, bool, int)) or
                                  isinstance(value, float) and math.isfinite(value))}


class ScopedMCP(FastMCP):
    async def call_tool(self, name, arguments):
        # FastMCP's default argument model ignores extra keys; reject capability overrides.
        if name not in ARGUMENTS or not isinstance(arguments, dict) or set(arguments) - ARGUMENTS[name]:
            raise ToolError("Unknown tool or unsupported arguments. Use ads_status, ads_contas or ads_relatorio.")
        return await super().call_tool(name, arguments)


mcp = ScopedMCP("CMKIA Ads reports", host="0.0.0.0", stateless_http=True, json_response=True,
                instructions="Read-only reports through the existing agency collector. No campaign, budget or account mutations. Check ads_status and ads_contas before reports. Source completeness and local pagination are separate; do not infer totals from an incomplete report.")
READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=True)
client = None


async def report_owner(payload):
    if not REPORT_URL:
        raise ToolError("Ads integration is pending. Ask the operator to mount the collector configuration and explicit account grants.")
    try:
        async with client.stream("POST", REPORT_URL, headers={"Authorization": "Bearer " + COLLECTOR_TOKEN}, json=payload) as response:
            if response.status_code in (401, 403):
                raise ToolError("The report collector refused authorization. Ask the operator to check its credential and account grants.")
            if response.status_code == 429:
                raise ToolError("The report collector is rate limited. Retry later with a shorter reporting period.")
            if response.status_code != 200:
                raise ToolError("The report collector did not complete the request. Ask the operator to check its availability; no totals are confirmed.")
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > MAX_BYTES:
                    raise ToolError("The report exceeds the response limit. Request a shorter period or one platform.")
        result = json.loads(body)
    except (httpx.HTTPError, ValueError, UnicodeError):
        raise ToolError("The report collector is unavailable or returned an invalid response. Ask the operator to check it; no totals are confirmed.") from None
    if not isinstance(result, dict) or result.get("ok") is not True or not isinstance(result.get("rows"), list):
        raise ToolError("The report owner could not confirm this read. Check account permissions and provider authorization with the operator; no totals are confirmed.")
    return result


@mcp.tool(annotations=READ_ONLY)
async def ads_status() -> dict:
    """Check live collector authorization. This health check does not test Meta or Google provider tokens."""
    status = {"configured": bool(REPORT_URL), "read_only": True, "account_grants": len(ACCOUNTS),
              "collector_authorized": False, "provider_authorization": "not_checked"}
    if not REPORT_URL:
        return {**status, "next_step": "Ask the operator to mount collector configuration and account grants."}
    try:
        result = await report_owner({"dataset": "health"})
        return {**status, "collector_authorized": True, "observed_at": safe_text(result.get("observed_at"))}
    except ToolError as error:
        return {**status, "next_step": str(error)}


@mcp.tool(annotations=READ_ONLY)
async def ads_contas() -> dict:
    """List only explicitly granted clients confirmed in the collector catalog. This does not test provider tokens."""
    result = await report_owner({"dataset": "accounts"})
    available = []
    for row in result["rows"]:
        if not isinstance(row, dict):
            continue
        grant = ACCOUNTS.get(row.get("client_id"))
        if grant and all(not grant[field] or row.get(field, "") == grant[field] for field in ("google_customer_id", "meta_account_id")):
            available.append(dict(grant))
    seen = {row["client_id"] for row in available}
    return {"accounts": available, "read_only": True, "provider_authorization": "not_checked",
            "complete": result.get("complete") is True,
            "unavailable_client_ids": [name for name in ACCOUNTS if name not in seen]}


@mcp.tool(annotations=READ_ONLY)
async def ads_relatorio(
    client_id: str,
    dataset: Literal["campaigns", "ads", "keywords"],
    platform: Literal["google_ads", "meta_ads", "both"],
    start: str,
    end: str,
    limit: Annotated[StrictInt, Field(ge=1, le=200)] = 100,
    offset: Annotated[StrictInt, Field(ge=0, le=10000)] = 0,
) -> dict:
    """Read daily campaign, ad or keyword metrics for an allowed client, ISO dates inclusive (maximum 93 days). Keywords support Google only. Cost and bid fields are currency units, not micros; use currency_code/time_zone and platform attribution definitions. Limit/offset paginate the returned report locally; each call asks the owner for the complete period. No URLs, raw queries or mutations are accepted."""
    grant = ACCOUNTS.get(client_id)
    if not grant:
        raise ToolError("Client is not authorized. Select a client returned by ads_contas.")
    try:
        if not all(re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value) for value in (start, end)):
            raise ValueError()
        days = (date.fromisoformat(end) - date.fromisoformat(start)).days
        if days < 0 or days > 92:
            raise ValueError()
    except ValueError:
        raise ToolError("Use valid ISO dates YYYY-MM-DD, start <= end, and no more than 93 inclusive days.") from None
    if dataset == "keywords" and platform == "meta_ads":
        raise ToolError("Keyword reports support Google Ads only.")
    google_id = grant["google_customer_id"] if platform != "meta_ads" else ""
    meta_id = grant["meta_account_id"] if platform != "google_ads" and dataset != "keywords" else ""
    if not google_id and not meta_id or platform == "google_ads" and not google_id or platform == "meta_ads" and not meta_id:
        raise ToolError("The selected platform has no account grant for this client.")
    result = await report_owner({"dataset": dataset, "google_customer_id": google_id, "meta_account_id": meta_id, "start": start, "end": end})
    selected = {"google_ads": google_id, "meta_ads": meta_id}
    rows = result["rows"]
    if any(not isinstance(row, dict) or not selected.get(row.get("platform")) or
           row.get("account_id") != selected[row["platform"]] or not isinstance(row.get("date"), str) or
           not start <= row["date"] <= end for row in rows):
        raise ToolError("The report owner returned rows outside the requested account or period. Ask the operator to investigate; no rows were released.")
    page = []
    for row in rows[offset:offset + limit]:
        clean = project(row, TEXT_FIELDS)
        clean.update({key: value for key, value in row.items() if key in NUMBER_FIELDS and
                      (value is None or type(value) in (int, float) and math.isfinite(value))})
        page.append(clean)
    has_more = offset + len(page) < len(rows)
    pagination_limited = has_more and offset + len(page) > 10000
    next_offset = offset + len(page) if has_more and not pagination_limited else None
    source_complete = result.get("complete") is True
    metadata = result.get("metadata")
    return {"rows": page, "read_only": True, "source_complete": source_complete,
            "complete": source_complete and offset == 0 and not has_more, "page_complete": True,
            "returned": len(page), "available_rows": len(rows), "offset": offset, "next_offset": next_offset,
            "pagination_limited": pagination_limited,
            "observed_at": safe_text(result.get("observed_at")),
            "metadata": project(metadata, METADATA_FIELDS) if isinstance(metadata, dict) else {},
            "coverage_note": "Only returned delivery rows; a partial source or any page alone cannot establish period totals. Each page call fetches again, so rows may change between calls; there is no snapshot guarantee. If pagination_limited, request a shorter period. No CRM leads or cross-platform deduplication are inferred."}


@asynccontextmanager
async def lifespan(_app):
    global client
    async with httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=httpx.Timeout(195, connect=15)) as active:
        client = active
        async with mcp.session_manager.run():
            yield
    client = None


api = FastAPI(title="CMKIA private Ads reports", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


@api.get("/healthz")
async def healthz():
    return {"ok": True, "read_only": True}


api.mount("/", mcp.streamable_http_app())


class BearerBoundary:
    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and not (scope["method"] == "GET" and scope["path"] == "/healthz"):
            headers = dict(scope.get("headers", []))
            value = headers.get(b"authorization", b"")
            token = value[7:] if value.startswith(b"Bearer ") else b""
            if not hmac.compare_digest(hashlib.sha256(token).digest(), KEY_HASH):
                await JSONResponse({"error": "Invalid broker credential"}, status_code=401)(scope, receive, send)
                return
        await api(scope, receive, send)


app = BearerBoundary()
