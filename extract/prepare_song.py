"""Prepare an automatically cross-checked local song chart in one command.

Runs two independent Demucs separators, keeps the standard model as the draft,
uses the fine-tuned ensemble as confidence evidence, creates browser audio, and
adds the song to the local-only catalog.

Usage:
    python3 extract/prepare_song.py song.wav --id song-id --title "Song" --artist "Artist"
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parent.parent


def run(*args):
    print("+", " ".join(str(a) for a in args), flush=True)
    subprocess.run([str(a) for a in args], cwd=ROOT, check=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("source")
    ap.add_argument("--id", required=True)
    ap.add_argument("--title", required=True)
    ap.add_argument("--artist", required=True)
    ap.add_argument("--device", default="cpu", choices=("cpu", "mps", "cuda"))
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", args.id):
        ap.error("--id must contain lowercase words separated by hyphens")

    source = Path(args.source).resolve()
    if not source.exists():
        ap.error(f"source not found: {source}")
    stem_name = source.stem
    standard_dir = ROOT / "separated" / "htdemucs" / stem_name
    alternate_dir = ROOT / "separated-ft" / "htdemucs_ft" / stem_name
    map_path = ROOT / "web" / "public" / "maps" / f"{args.id}.json"
    alt_map = ROOT / "web" / "public" / "maps" / f"{args.id}.alternate.json"
    audio_path = ROOT / "web" / "audio" / f"{args.id}.m4a"

    if args.force or not (standard_dir / "vocals.wav").exists():
        run(sys.executable, "-m", "demucs", "-n", "htdemucs", "--two-stems=vocals",
            "-d", args.device, "-o", "separated", source)
    if args.force or not (alternate_dir / "vocals.wav").exists():
        run(sys.executable, "-m", "demucs", "-n", "htdemucs_ft", "--two-stems=vocals",
            "-d", args.device, "-o", "separated-ft", source)

    for vocals, accompaniment, output in (
        (standard_dir / "vocals.wav", standard_dir / "no_vocals.wav", map_path),
        (alternate_dir / "vocals.wav", alternate_dir / "no_vocals.wav", alt_map),
    ):
        run(sys.executable, "extract/extract_contour.py", vocals, output,
            "--title", args.title, "--artist", args.artist, "--accompaniment", accompaniment)
        run(sys.executable, "extract/segment_notes.py", output, "--diagnose")
    run(sys.executable, "extract/compare_maps.py", map_path, alt_map)
    run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", source,
        "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", audio_path)

    catalog_path = ROOT / "web" / "songs.local.json"
    catalog = json.load(open(catalog_path)) if catalog_path.exists() else []
    entry = {"id": args.id, "title": args.title, "artist": args.artist}
    catalog = [entry if item.get("id") == args.id else item for item in catalog]
    if not any(item.get("id") == args.id for item in catalog):
        catalog.append(entry)
    with open(catalog_path, "w") as fh:
        json.dump(catalog, fh, indent=2)
        fh.write("\n")
    print(f"\nPlayable chart ready: http://localhost:8000/?song={args.id}")


if __name__ == "__main__":
    main()
