#!/usr/bin/env python3
"""Opt-in REST regression for authenticated Drive links.

Run only against an approved client with an existing, private synthetic file in
its assigned Drive folder. This creates import jobs but never changes sharing.
The configuration, key, URLs and resource IDs stay outside the report.

Configuration JSON: base_url, key_file, private_file_url, assigned_folder_url;
public_url is optional (defaults to https://example.com/).
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class ContractFailure(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ContractFailure(message)


class Client:
    def __init__(self, base_url: str, key: str):
        self.base_url = base_url.rstrip('/')
        self.key = key
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(self, method: str, path: str, payload=None) -> tuple[int, dict]:
        body = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(
            self.base_url + path, data=body, method=method,
            headers={'Authorization': 'Bearer ' + self.key, 'Content-Type': 'application/json'},
        )
        try:
            with self.opener.open(request, timeout=180) as response:
                status, data = response.status, response.read()
        except urllib.error.HTTPError as error:
            status, data = error.code, error.read()
        except (urllib.error.URLError, TimeoutError):
            raise ContractFailure('Library transport failed; no credentials or URLs logged') from None
        try:
            value = json.loads(data)
        except (ValueError, UnicodeDecodeError):
            raise ContractFailure(f'Expected a JSON library response, received HTTP {status}') from None
        require(isinstance(value, dict), 'Library response must be an object')
        return status, value


def scope_denied(status: int, value: dict) -> None:
    message = str(value.get('detail', '')).lower()
    detail = message[:500]
    require(status == 400,
            f'Out-of-scope Drive link must fail before queueing; HTTP {status}; detail={detail}')
    require('folder' in message or 'pasta' in message,
            f'Scope error must identify the assigned folder; detail={detail}')
    require(any(action in message for action in ('move', 'place', 'use that folder', 'coloque', 'mova', 'assigned', 'autorizad')),
            f'Scope error must explain the next action within the existing folder grant; detail={detail}')
    require(not any(advice in message for advice in (
        'anyone with the link', 'qualquer pessoa com o link', 'make it public', 'torne p\u00fablico', 'torne publico',
    )), 'Drive error must never ask the user to make private material public')


def run(config: dict) -> list[str]:
    key = Path(config['key_file']).read_text().strip()
    require(len(key) >= 32, 'A configured library key file is required')
    client = Client(config['base_url'], key)
    checks = []

    code, state = client.request('GET', '/v1/drive/status')
    require(code == 200 and state.get('authorized') is True,
            'Fixture prerequisite failed: central Drive OAuth is not authorized')
    checks.append('central_oauth_authorized')

    code, imported = client.request('POST', '/v1/import/url', {
        'url': config['private_file_url'], 'title': 'Synthetic authenticated Drive link regression',
    })
    require(code == 200, f'Authorized private Drive file must import; HTTP {code}')
    require(imported.get('route') == 'authorized_drive',
            'Private Drive link was routed to public URL import instead of the authorized broker')
    require(bool(imported.get('job_id') or imported.get('document_id')),
            'Authorized Drive import must return the durable job or existing document')
    checks.append('private_file_uses_authorized_drive')

    code, folder = client.request('POST', '/v1/import/url', {
        'url': config['assigned_folder_url'], 'title': 'Synthetic authorized folder regression',
    })
    require(code == 200 and folder.get('route') == 'authorized_drive',
            'Assigned folder link must use the authorized Drive synchronization owner')
    checks.append('assigned_folder_uses_authorized_drive')

    # Synthetic resource IDs exercise scope rejection without touching another client.
    for label, url in (
        ('outside_file', 'https://drive.google.com/file/d/synthetic_outside_assigned_scope/view'),
        ('outside_folder', 'https://drive.google.com/drive/u/1/folders/synthetic_outside_assigned_scope'),
    ):
        code, rejected = client.request('POST', '/v1/import/url', {'url': url, 'title': 'Synthetic scope denial'})
        scope_denied(code, rejected)
        checks.append(label + '_rejected_without_public_fallback')

    code, malformed = client.request('POST', '/v1/import/url', {
        'url': 'https://drive.google.com/file/d//view', 'title': 'Synthetic malformed Drive link',
    })
    require(code == 400, 'Malformed recognized Drive links must fail closed before public import')
    checks.append('malformed_drive_link_rejected')

    code, public = client.request('POST', '/v1/import/url', {
        'url': config.get('public_url', 'https://example.com/'), 'title': 'Synthetic public URL regression',
    })
    require(code == 200 and bool(public.get('job_id')), 'Public URL ingestion must remain available')
    require(public.get('route') != 'authorized_drive', 'Ordinary public URLs must retain their public route')
    checks.append('public_url_route_preserved')
    return checks


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path, help='Protected, untracked JSON configuration')
    parser.add_argument('--report', type=Path, help='Optional sanitized proof report')
    args = parser.parse_args()
    started = time.monotonic()
    try:
        config = json.loads(args.config.read_text())
        checks = run(config)
        report = {'passed': True, 'checks': checks}
    except ContractFailure as error:
        report = {'passed': False, 'error': str(error)}
    except (OSError, ValueError, KeyError):
        report = {'passed': False, 'error': 'Invalid or unavailable protected proof configuration'}
    report['wall_seconds'] = round(time.monotonic() - started, 3)
    encoded = json.dumps(report, indent=2) + '\n'
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(encoded)
    print(encoded, end='')
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
