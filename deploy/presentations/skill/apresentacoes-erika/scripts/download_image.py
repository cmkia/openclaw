#!/usr/bin/env python3
"""Download one completed HTTPS image; read its temporary URL only from stdin."""

import argparse
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import secrets
import socket
import ssl
import sys
from urllib.parse import urljoin, urlsplit


MAX_BYTES = 20 * 1024 * 1024
MAX_URL_BYTES = 16384


class DownloadError(Exception):
    pass


class PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, hostname, addresses):
        super().__init__(hostname, port=443, timeout=30, context=ssl.create_default_context())
        self.addresses = addresses

    def connect(self):
        # Connect to the validated numeric address, preserving hostname certificate
        # verification and SNI. Neither a proxy nor a second DNS lookup is used.
        for address in self.addresses:
            raw = None
            try:
                raw = socket.create_connection((address, 443), timeout=self.timeout)
                self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
                return
            except OSError:
                if raw is not None:
                    raw.close()
        raise DownloadError("Could not establish a verified HTTPS image connection.")


def connection(url):
    try:
        parsed = urlsplit(url)
        if parsed.scheme.lower() != "https" or not parsed.hostname or parsed.username is not None or parsed.password is not None or parsed.port not in (None, 443):
            raise ValueError()
        if len(url.encode("utf-8")) > MAX_URL_BYTES or any(ord(char) < 33 or ord(char) == 127 for char in url):
            raise ValueError()
        hostname = parsed.hostname.encode("idna").decode("ascii")
        records = socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)
        addresses = list(dict.fromkeys(record[4][0] for record in records))
        if not addresses:
            raise ValueError()
        for address in addresses:
            ip = ipaddress.ip_address(address)
            if not ip.is_global or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
                raise ValueError()
    except (ValueError, UnicodeError, OSError):
        raise DownloadError("Image URL must resolve only to public HTTPS addresses on port 443.") from None
    addresses.sort(key=lambda address: ":" in address)
    target = parsed.path or "/"
    if parsed.query:
        target += "?" + parsed.query
    return PinnedHTTPS(hostname, addresses), target


def stream_image(url, destination):
    for redirect in range(6):
        client, target = connection(url)
        try:
            client.request("GET", target, headers={"Accept": "image/png,image/jpeg", "Accept-Encoding": "identity", "User-Agent": "OpenClaw-Presentation-Image/1"})
            response = client.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader("Location")
                if not location or redirect == 5:
                    raise DownloadError("Image download exceeded the redirect limit or has no destination.")
                url = urljoin(url, location)
                continue
            if response.status != 200 or response.getheader("Content-Encoding", "identity").lower() != "identity":
                raise DownloadError("Image server did not return an uncompressed downloadable image.")
            length = response.getheader("Content-Length")
            if length is not None and (not length.isdigit() or int(length) > MAX_BYTES):
                raise DownloadError("Image download exceeds the 20 MiB limit or has an invalid length.")
            digest, size, beginning, ending = hashlib.sha256(), 0, b"", b""
            while chunk := response.read(65536):
                size += len(chunk)
                if size > MAX_BYTES:
                    raise DownloadError("Image download exceeds the 20 MiB limit.")
                beginning = (beginning + chunk)[:8]
                ending = (ending + chunk)[-12:]
                digest.update(chunk)
                destination.write(chunk)
            if length is not None and size != int(length):
                raise DownloadError("Image download ended before the declared length.")
            if beginning == b"\x89PNG\r\n\x1a\n" and ending == b"\x00\x00\x00\x00IEND\xaeB`\x82" and size >= 45:
                image_format = "png"
            elif beginning.startswith(b"\xff\xd8\xff") and ending.endswith(b"\xff\xd9") and size >= 16:
                image_format = "jpeg"
            else:
                raise DownloadError("Downloaded bytes are not a complete PNG or JPEG image.")
            return {"bytes": size, "sha256": digest.hexdigest(), "format": image_format}
        finally:
            client.close()
    raise DownloadError("Image download exceeded the redirect limit.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, help="New workspace-relative .png, .jpg, or .jpeg file")
    parser.add_argument("--workspace", help="Absolute tenant workspace; defaults to OPENCLAW_WORKSPACE_DIR or cwd")
    args = parser.parse_args()
    raw_root = Path(args.workspace or os.environ.get("OPENCLAW_WORKSPACE_DIR") or os.getcwd())
    if not raw_root.is_absolute():
        raise DownloadError("The tenant workspace must be an absolute directory.")
    root = raw_root.resolve(strict=True)
    parts = args.output.split("/")
    relative = PurePosixPath(args.output)
    if relative.is_absolute() or "\\" in args.output or any(part in ("", ".", "..") for part in parts) or any(ord(char) < 32 for char in args.output):
        raise DownloadError("Output must be a normalized relative path inside the tenant workspace.")
    suffix = relative.suffix.lower()
    if suffix not in (".png", ".jpg", ".jpeg"):
        raise DownloadError("Output extension must be .png, .jpg, or .jpeg.")
    raw_url = sys.stdin.buffer.read(MAX_URL_BYTES + 1)
    if len(raw_url) > MAX_URL_BYTES:
        raise DownloadError("Image URL exceeds the input limit.")
    url = raw_url.decode("utf-8").strip()
    directory_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary = None
    try:
        # Traverse through directory descriptors so a symlink cannot redirect
        # parent creation, temporary writes, or the exclusive final publication.
        for part in parts[:-1]:
            try:
                os.mkdir(part, mode=0o755, dir_fd=directory_fd)
            except FileExistsError:
                pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
            os.close(directory_fd)
            directory_fd = child
        try:
            os.stat(parts[-1], dir_fd=directory_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise DownloadError("Destination already exists; choose a new output filename.")
        temporary = ".image-" + secrets.token_hex(16) + ".part"
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
        with os.fdopen(descriptor, "wb") as output:
            result = stream_image(url, output)
            if (result["format"] == "png") != (suffix == ".png"):
                raise DownloadError("Image bytes do not match the requested filename extension.")
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, parts[-1], src_dir_fd=directory_fd, dst_dir_fd=directory_fd, follow_symlinks=False)
        print(json.dumps({"path": relative.as_posix(), **result}))
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary, dir_fd=directory_fd)
            except FileNotFoundError:
                pass
        os.close(directory_fd)


if __name__ == "__main__":
    try:
        main()
    except DownloadError as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, http.client.HTTPException):
        # Signed URLs and server errors can contain temporary credentials. Keep
        # them out of stdout/stderr, manifests, prompts, and delivery messages.
        print(json.dumps({"error": "Image download failed. Check HTTPS access, file format, output permissions, and that the destination is new."}), file=sys.stderr)
        sys.exit(1)
