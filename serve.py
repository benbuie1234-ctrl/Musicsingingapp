#!/usr/bin/env python3
"""Dev server for the web app.

Microphone access needs a secure origin. On the machine itself `localhost`
counts as one, so plain HTTP is enough. A phone on the same network does NOT
get that exemption -- it reaches this server by LAN IP, which is not a secure
origin, and the browser will refuse the microphone before even prompting. So:

    python3 serve.py --https

generates a self-signed certificate and serves over TLS, which does satisfy the
secure-origin rule. The phone will warn once about the certificate; accept it
and the mic works.

Uses an explicit chdir rather than `python3 -m http.server --directory`, whose
argparse defaults call os.getcwd() at import time and fail when launched from a
directory the process cannot stat.
"""
import argparse
import http.server
import os
import socket
import socketserver
import ssl
import subprocess
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
CERT = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".devcert")


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # no caching, so an edited module is the one you actually reload
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def lan_ip():
    """Best guess at the address a phone on the same network should use."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))       # no packets sent; just picks a route
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert():
    key, crt = CERT + ".key", CERT + ".crt"
    if os.path.exists(key) and os.path.exists(crt):
        return key, crt
    ip = lan_ip()
    sys.stderr.write(f"generating a self-signed certificate for {ip}\n")
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", key, "-out", crt, "-days", "825",
        "-subj", "/CN=sing-dev",
        "-addext", f"subjectAltName=IP:{ip},IP:127.0.0.1,DNS:localhost",
    ], check=True, capture_output=True)
    return key, crt


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("port", nargs="?", type=int, default=8000)
    ap.add_argument("--https", action="store_true",
                    help="serve over TLS so a phone on the LAN can use the mic")
    args = ap.parse_args()

    os.chdir(ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    bind = "" if args.https else "127.0.0.1"

    with socketserver.TCPServer((bind, args.port), Handler) as httpd:
        scheme = "http"
        if args.https:
            key, crt = ensure_cert()
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(crt, key)
            httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
            scheme = "https"
        sys.stderr.write(f"serving {ROOT}\n  {scheme}://localhost:{args.port}\n")
        if args.https:
            sys.stderr.write(f"  {scheme}://{lan_ip()}:{args.port}   <- from your phone\n")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
