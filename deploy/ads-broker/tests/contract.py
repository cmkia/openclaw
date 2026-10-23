"""MCP boundary proof with only the external report collector stubbed.

Run: python tests/contract.py (from deploy/ads-broker, with requirements installed).
One ASGI lifespan covers authentication, scope, read-only dispatch, serialization,
projection and error handling. No provider requests, ports, sleeps or processes.
"""

import asyncio
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from unittest.mock import patch

import httpx


KEY = "synthetic-broker-key-0123456789abcdef"
TOKEN = "synthetic-collector-token-0123456789abcdef"
GRANT = {"client_id": "synthetic", "google_customer_id": "1234567890", "meta_account_id": "987654321"}
ROW = {"date": "2026-10-22", "platform": "google_ads", "account_id": GRANT["google_customer_id"],
       "campaign_id": "123", "campaign_name": "Search", "cost": 12.5,
       "currency_code": "BRL", "time_zone": "America/Sao_Paulo", "impressions": 100}


async def contract():
    # openclaw-temp-dir: allow mounted-secret file contract needs real files, never real credentials.
    with tempfile.TemporaryDirectory(prefix="openclaw-ads-contract-") as directory:
        directory = Path(directory)
        (directory / "key").write_text(KEY)
        (directory / "credentials").write_text(json.dumps({
            "report_url": "https://flows.example.test/webhook/agency-report-read-v1",
            "collector_token": TOKEN, "accounts": [GRANT],
        }))
        with patch.dict(os.environ, {"ADS_API_KEY_FILE": str(directory / "key"), "ADS_CREDENTIALS_FILE": str(directory / "credentials")}):
            spec = importlib.util.spec_from_file_location("ads_contract_app", Path(__file__).resolve().parents[1] / "app.py")
            broker = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(broker)
        requests = []
        mode = "normal"

        async def upstream(request, **kwargs):
            nonlocal mode
            assert request.method == "POST"
            assert str(request.url) == "https://flows.example.test/webhook/agency-report-read-v1"
            assert request.headers["Authorization"] == "Bearer " + TOKEN
            assert kwargs.get("follow_redirects") is not True
            payload = json.loads(request.content)
            requests.append(payload)
            if mode == "unauthorized":
                return httpx.Response(401, json={"error": TOKEN + " https://secret.invalid?token=" + KEY}, request=request)
            if mode == "redirect":
                return httpx.Response(302, headers={"location": "https://evil.invalid/?token=" + TOKEN}, request=request)
            if mode == "invalid_json":
                return httpx.Response(200, content=TOKEN.encode(), request=request)
            if mode == "owner_error":
                return httpx.Response(200, json={"ok": False, "rows": [], "error": {"message": TOKEN}}, request=request)
            if mode == "large":
                return httpx.Response(200, content=b" " * (broker.MAX_BYTES + 1), request=request)
            if payload["dataset"] == "health":
                response = {"ok": True, "complete": True, "rows": [], "observed_at": "2026-10-23T00:00:00Z"}
            elif payload["dataset"] == "accounts":
                response = {"ok": True, "complete": True, "rows": [{**GRANT, "briefing_folder_id": "private-folder"},
                            {"client_id": "other-private-client", "google_customer_id": "999", "meta_account_id": "888"}]}
            else:
                rows = [{**ROW, "campaign_name": "Name " + TOKEN + " https://ad.example/?access_token=another-secret",
                         "thumbnail_data": "private-image-bytes", "secret_field": KEY, "search_term": "person@example.test"},
                        {**ROW, "campaign_id": "124"}]
                if mode == "wrong_scope":
                    rows[0]["account_id"] = "9999999999"
                if payload.get("meta_account_id") and not payload.get("google_customer_id"):
                    rows = [{**ROW, "platform": "meta_ads", "account_id": GRANT["meta_account_id"]}]
                response = {"ok": True, "complete": mode != "incomplete", "rows": rows,
                            "metadata": {"coverage": "Only returned delivery rows", "secret": TOKEN}}
            return httpx.Response(200, json=response, request=request)

        async with broker.api.router.lifespan_context(broker.api):
            with patch.object(broker.client, "send", side_effect=upstream):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=broker.app), base_url="http://broker.test") as web:
                    assert (await web.get("/healthz")).status_code == 200
                    for path in ("/mcp", "/docs", "/openapi.json", "/anything"):
                        assert (await web.post(path, json={})).status_code == 401
                    assert (await web.post("/mcp", headers={"Authorization": "Bearer invalid"}, json={})).status_code == 401
                    assert not requests
                    headers = {"Authorization": "Bearer " + KEY, "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25"}
                    sequence = 0

                    async def rpc(method, params):
                        nonlocal sequence
                        sequence += 1
                        response = await web.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": sequence, "method": method, "params": params})
                        assert response.status_code == 200, (response.status_code, response.text)
                        assert KEY not in response.text and TOKEN not in response.text
                        return response.json()

                    async def call(name, arguments=None, error=False):
                        result = (await rpc("tools/call", {"name": name, "arguments": arguments or {}}))["result"]
                        assert bool(result.get("isError")) is error, result
                        if error:
                            return result
                        return result.get("structuredContent") or json.loads(result["content"][0]["text"])

                    initialized = await rpc("initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "contract", "version": "1"}})
                    assert initialized["result"]["capabilities"]["tools"] is not None
                    listed = (await rpc("tools/list", {}))["result"]["tools"]
                    assert {tool["name"] for tool in listed} == {"ads_status", "ads_contas", "ads_relatorio"}
                    assert all(tool["annotations"]["readOnlyHint"] and not tool["annotations"]["destructiveHint"] for tool in listed)
                    status = await call("ads_status")
                    assert status["collector_authorized"] is True and status["provider_authorization"] == "not_checked"
                    accounts = await call("ads_contas")
                    assert accounts["accounts"] == [GRANT] and "private" not in json.dumps(accounts)
                    args = {"client_id": "synthetic", "dataset": "campaigns", "platform": "google_ads", "start": "2026-10-22", "end": "2026-10-22", "limit": 1}
                    first = await call("ads_relatorio", args)
                    assert requests[-1] == {"dataset": "campaigns", "google_customer_id": "1234567890", "meta_account_id": "", "start": "2026-10-22", "end": "2026-10-22"}
                    assert first["rows"][0]["cost"] == 12.5 and first["rows"][0]["currency_code"] == "BRL"
                    assert first["source_complete"] is True and first["complete"] is False and first["next_offset"] == 1
                    assert "thumbnail_data" not in first["rows"][0] and "secret_field" not in first["rows"][0] and "search_term" not in first["rows"][0]
                    assert "another-secret" not in json.dumps(first) and "secret" not in first["metadata"]
                    last = await call("ads_relatorio", {**args, "offset": 1})
                    assert last["complete"] is False and last["source_complete"] is True and last["next_offset"] is None and last["offset"] == 1
                    await call("ads_relatorio", {**args, "platform": "meta_ads"})
                    assert requests[-1]["google_customer_id"] == "" and requests[-1]["meta_account_id"] == GRANT["meta_account_id"]
                    await call("ads_relatorio", {**args, "dataset": "keywords", "platform": "both"})
                    assert requests[-1]["meta_account_id"] == "" and requests[-1]["dataset"] == "keywords"
                    before = len(requests)
                    for invalid in ({"client_id": "other-private-client"}, {"client_id": "https://evil.invalid"}, {"dataset": "delete"},
                                    {"dataset": "keywords", "platform": "meta_ads"}, {"start": "2026-02-30"}, {"end": "2026-01-01"},
                                    {"start": "2026-01-01"}, {"limit": 201}, {"limit": 0}, {"offset": -1}, {"offset": 10001},
                                    {"url": "https://evil.invalid"}, {"action": "mutate"}, {"credential_profile": "another"}, {"query": "DELETE"}):
                        await call("ads_relatorio", {**args, **invalid}, error=True)
                    await call("campaigns_delete", error=True)
                    assert "error" in await rpc("campaigns/mutate", {})
                    assert len(requests) == before
                    mode = "incomplete"
                    incomplete = await call("ads_relatorio", {**args, "limit": 200})
                    assert incomplete["source_complete"] is False and incomplete["complete"] is False and incomplete["next_offset"] is None
                    for mode in ("wrong_scope", "unauthorized", "redirect", "invalid_json", "owner_error", "large"):
                        await call("ads_relatorio", args, error=True)
                    mode = "unauthorized"
                    status = await call("ads_status")
                    assert status["collector_authorized"] is False and status["provider_authorization"] == "not_checked"
    print("PASS: actual ASGI MCP authentication, read-only dispatch, fixed owner requests, scope, dates, pagination and redaction")


if __name__ == "__main__":
    asyncio.run(contract())
