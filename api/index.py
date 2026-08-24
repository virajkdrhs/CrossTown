"""Vercel serverless entrypoint.

Vercel routes every /api/* request here and runs the FastAPI app as an ASGI
handler. Importing the app at module scope means the GTFS feed is parsed once per
warm container (about 0.9s) rather than per request.
"""

import sys
from pathlib import Path

# The function bundle puts this file under api/; the Backend package sits one
# level up, so make the repository root importable.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from Backend.main import app  # noqa: E402

# Vercel's Python runtime looks for `app` (ASGI) or `handler`.
handler = app
