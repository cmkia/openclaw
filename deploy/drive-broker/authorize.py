#!/usr/bin/env python3
"""Authorize the operator's read-only Drive account through a loopback callback."""

import argparse
import json
import os
from pathlib import Path

from google_auth_oauthlib.flow import InstalledAppFlow


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--client", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--login-hint", required=True)
    parser.add_argument("--port", type=int, default=15003)
    args = parser.parse_args()
    flow = InstalledAppFlow.from_client_secrets_file(
        str(args.client), scopes=["https://www.googleapis.com/auth/drive.readonly"]
    )
    credentials = flow.run_local_server(
        host="127.0.0.1", port=args.port, open_browser=False,
        login_hint=args.login_hint, access_type="offline", prompt="consent",
        timeout_seconds=900,
        success_message="Drive autorizado. Pode fechar esta aba.",
    )
    if not credentials or not credentials.refresh_token:
        raise RuntimeError("Google did not issue an offline refresh token")
    data = json.loads(credentials.to_json())
    data["type"] = "authorized_user"
    with os.fdopen(os.open(args.output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w") as stream:
        json.dump(data, stream)
    print("Read-only Drive authorization saved to a protected operator file.")


if __name__ == "__main__":
    main()
