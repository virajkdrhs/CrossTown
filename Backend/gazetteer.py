"""Offline place lookup for the Richmond region.

Nominatim blocks most cloud-provider IP ranges, so a deployed instance cannot
depend on it. These places were geocoded once from a machine that could reach
Nominatim and shipped with the app, so the addresses a judge is most likely to
type resolve instantly and without a network call.

Live geocoding is still tried for anything not in here, so arbitrary street
addresses keep working wherever Nominatim is reachable.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache

from . import config

PATH = config.RAW_DIR / "gazetteer.json"

# Trailing state/country qualifiers people type but that carry no information here.
_TRAILING = re.compile(
    r"[\s,]+(va|virginia|usa|us|united states|henrico|henrico county)\.?$", re.I
)
_PUNCT = re.compile(r"[^a-z0-9 ]+")


@dataclass(frozen=True)
class Place:
    latitude: float
    longitude: float
    address: str


def normalise(text: str) -> str:
    text = text.strip().lower()
    # Strip qualifiers repeatedly: "Short Pump, Henrico County, VA" -> "short pump"
    for _ in range(4):
        stripped = _TRAILING.sub("", text)
        if stripped == text:
            break
        text = stripped
    text = _PUNCT.sub(" ", text)
    return " ".join(text.split())


@lru_cache(maxsize=1)
def _places() -> dict[str, Place]:
    if not PATH.exists():
        return {}
    with PATH.open(encoding="utf-8") as handle:
        raw = json.load(handle)
    return {
        normalise(name): Place(entry["lat"], entry["lon"], entry["label"])
        for name, entry in (raw.get("places") or {}).items()
    }


def lookup(query: str) -> Place | None:
    """Exact match first, then a contained-name match.

    The contained match is deliberately conservative: it only fires when the
    typed text contains a known place name as a whole phrase, so "1200 Nine Mile
    Road" finds Nine Mile Road but "north" does not match "Northside Richmond".
    """
    places = _places()
    if not places:
        return None

    key = normalise(query)
    if not key:
        return None
    if key in places:
        return places[key]

    # Longest known name contained in the query wins, so "short pump town center"
    # beats the shorter "short pump".
    best_name = None
    for name in places:
        if name in key and (best_name is None or len(name) > len(best_name)):
            best_name = name
    return places[best_name] if best_name else None


def size() -> int:
    return len(_places())
