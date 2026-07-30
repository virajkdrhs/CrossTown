"""Download the current GRTC GTFS feed into Data/Raw/gtfs.zip.

The feed is not committed (it is 4 MB of third-party data that expires), so this
gives teammates a one-command way to get a working transit router.

Source URL published by GRTC and catalogued at https://www.transit.land/feeds/f-grtc~va
"""

from __future__ import annotations

import sys
import urllib.request
import zipfile

from . import config

FEED_URL = "https://www.ridegrtc.com/wp-content/uploads/2025/02/gtfs.zip"
REQUIRED_MEMBERS = {"stops.txt", "stop_times.txt", "trips.txt", "calendar.txt"}


def main() -> int:
    destination = config.GTFS_ZIP
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".zip.part")

    print(f"Downloading GRTC GTFS feed from {FEED_URL} ...")
    try:
        with urllib.request.urlopen(FEED_URL, timeout=120) as response:
            payload = response.read()
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: download failed ({exc}).")
        print("       GRTC occasionally moves this file. Check the current URL at")
        print("       https://www.transit.land/feeds/f-grtc~va and update FEED_URL.")
        return 1

    temporary.write_bytes(payload)

    # Verify before overwriting a working feed with an HTML error page.
    try:
        with zipfile.ZipFile(temporary) as archive:
            members = set(archive.namelist())
    except zipfile.BadZipFile:
        temporary.unlink(missing_ok=True)
        print("ERROR: the download is not a zip file (the URL may now serve an error page).")
        return 1

    missing = REQUIRED_MEMBERS - members
    if missing:
        temporary.unlink(missing_ok=True)
        print(f"ERROR: feed is missing required files: {sorted(missing)}")
        return 1

    temporary.replace(destination)
    size_mb = len(payload) / 1_000_000
    print(f"Saved {destination.relative_to(config.ROOT_DIR)} ({size_mb:.1f} MB)")

    from . import gtfs  # noqa: PLC0415 - imported after the file is in place

    feed = gtfs.load_feed()
    print(
        f"Feed valid {feed.feed_start}-{feed.feed_end}: "
        f"{len(feed.stops)} stops, {len(feed.routes)} routes, "
        f"{len(feed.connections):,} connections"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
