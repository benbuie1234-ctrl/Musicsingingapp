"""Fetch album art for the local song catalog.

Art is looked up on Apple's public iTunes Search endpoint and stored under
web/art/, which is gitignored along with the audio -- cover art is as
copyrighted as the recording. If a lookup fails the app falls back to a
generated gradient, so this is a nicety and never a dependency.

Usage:
    python3 extract/fetch_art.py            # every song in the local catalog
    python3 extract/fetch_art.py song-id    # just one
"""
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / "web" / "art"


def catalog():
    for name in ("songs.local.json", "songs.json"):
        p = ROOT / "web" / name
        if p.exists():
            return json.loads(p.read_text())
    return []


def lookup(title, artist):
    q = urllib.parse.urlencode({
        "term": f"{artist} {title}", "media": "music", "entity": "song", "limit": 5,
    })
    url = f"https://itunes.apple.com/search?{q}"
    with urllib.request.urlopen(url, timeout=15) as r:
        results = json.load(r).get("results", [])
    for item in results:
        art = item.get("artworkUrl100")
        if art:
            # the 100px URL swaps cleanly to any size
            return art.replace("100x100bb", "600x600bb")
    return None


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    ART.mkdir(parents=True, exist_ok=True)
    for song in catalog():
        if only and song["id"] != only:
            continue
        dest = ART / f"{song['id']}.jpg"
        try:
            url = lookup(song["title"], song["artist"])
            if not url:
                print(f"  {song['id']}: no artwork found")
                continue
            with urllib.request.urlopen(url, timeout=20) as r:
                dest.write_bytes(r.read())
            print(f"  {song['id']}: {dest.stat().st_size // 1024} KB")
        except Exception as e:
            print(f"  {song['id']}: lookup failed ({e})")


if __name__ == "__main__":
    main()
