"""Public URL downloads resolve once and connect to the checked address."""
import hashlib
import ipaddress
import socket
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx

from .config import MAX_BYTES
from .drive import parse_link


def pinned_url(url: str) -> tuple[str, str, str]:
    if parse_link(url) is not None:
        raise ValueError('Google Drive links require the authorized private folder importer; keep sharing restricted')
    parts = urlsplit(url)
    if parts.scheme not in ('https', 'http') or not parts.hostname or parts.username or parts.password:
        raise ValueError('Only public HTTP(S) URLs without credentials are accepted')
    port = parts.port or (443 if parts.scheme == 'https' else 80)
    if port not in (80, 443):
        raise ValueError('Only public HTTP(S) ports 80 and 443 are accepted')
    addresses = socket.getaddrinfo(parts.hostname, port, type=socket.SOCK_STREAM)
    ips = list(dict.fromkeys(record[4][0] for record in addresses))
    if not ips or any(not ipaddress.ip_address(ip).is_global for ip in ips):
        raise ValueError('Private, loopback and reserved destinations are not allowed')
    ip = ips[0]
    netloc = ('[' + ip + ']' if ':' in ip else ip) + ':' + str(port)
    host = parts.hostname if port in (80, 443) else parts.netloc
    return urlunsplit((parts.scheme, netloc, parts.path or '/', parts.query, '')), host, parts.hostname


def download_public(url: str, target: Path) -> dict:
    current = url
    with httpx.Client(timeout=httpx.Timeout(120, connect=20), follow_redirects=False, trust_env=False) as client:
        for _ in range(6):
            address, host, tls_name = pinned_url(current)
            with client.stream('GET', address, headers={'Host': host, 'Accept-Encoding': 'identity'},
                               extensions={'sni_hostname': tls_name}) as response:
                if response.is_redirect:
                    location = response.headers.get('location')
                    if not location:
                        raise ValueError('Redirect without a destination')
                    current = urljoin(current, location)
                    continue
                response.raise_for_status()
                if int(response.headers.get('content-length', 0)) > MAX_BYTES:
                    raise ValueError('Document exceeds the configured import size limit')
                digest = hashlib.sha256()
                size = 0
                try:
                    with target.open('wb') as handle:
                        for part in response.iter_bytes(1024 * 1024):
                            size += len(part)
                            if size > MAX_BYTES:
                                raise ValueError('Document exceeds the configured import size limit')
                            digest.update(part)
                            handle.write(part)
                    return {'sha256': digest.hexdigest(), 'byte_size': size,
                            'content_type': response.headers.get('content-type', ''), 'url': current}
                except BaseException:
                    target.unlink(missing_ok=True)
                    raise
    raise ValueError('Too many redirects')
