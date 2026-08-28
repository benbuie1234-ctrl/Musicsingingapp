#!/usr/bin/env python3
"""Dev server for the web app.

Mic capture needs a secure origin, so file:// will not work -- localhost counts
as secure and this is the shortest path to it. Uses an explicit chdir rather
than `python3 -m http.server --directory`, whose argparse defaults call
os.getcwd() at import time and blow up when launched from a directory the
process cannot stat.
"""
import http.server
import os
import socketserver
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # no caching, so an edited module is the one you actually reload
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


os.chdir(ROOT)
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
    sys.stderr.write(f"serving {ROOT} at http://localhost:{PORT}\n")
    httpd.serve_forever()
