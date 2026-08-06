"""Static file server for the CrossTown frontend, with caching disabled.

`python -m http.server` sends no cache headers, so browsers hold on to ES
modules for the life of the tab. Editing a file under js/ then reloading serves
the *old* module, which looks exactly like a bug in your new code - the app half
initialises with no console error.

    python Frontend/dev_server.py [port]

Development only: no-store on every response is the opposite of what you want in
production.
"""

from __future__ import annotations

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

FRONTEND_DIR = Path(__file__).resolve().parent
DEFAULT_PORT = 5500


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):  # quieter than the default one line per asset
        if "GET" in (fmt % args) and " 200 " in (fmt % args):
            return
        super().log_message(fmt, *args)


def main() -> int:
    port = DEFAULT_PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print(f"Invalid port '{sys.argv[1]}'")
            return 1

    handler = partial(NoCacheHandler, directory=str(FRONTEND_DIR))
    with ThreadingHTTPServer(("127.0.0.1", port), handler) as server:
        print(f"CrossTown frontend on http://127.0.0.1:{port} (caching disabled)")
        print("Backend expected at http://127.0.0.1:8000 - Ctrl+C to stop.")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
