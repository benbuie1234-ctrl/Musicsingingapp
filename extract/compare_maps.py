"""Cross-check a generated note map with an independent vocal separation.

Disagreement stays diagnostic because a real breathy note may survive only one
separator. Agreement can conservatively recover a note the primary separator
rejected when the alternate stem isolates that same pitch above accompaniment.

Usage:
    python3 compare_maps.py primary.json alternate.json
"""
import json
import sys

import numpy as np


def pitch_class_distance(a, b):
    return abs(a - 12 * np.round((a - b) / 12) - b)


def annotate(items, alternate, alternate_dominance, hop):
    flagged = 0
    for note in items:
        a = max(0, int(round(note["start"] / hop)))
        b = min(len(alternate), max(a + 1, int(round(note["end"] / hop))))
        values = np.array([np.nan if v is None else float(v) for v in alternate[a:b]])
        voiced = np.isfinite(values)
        support = float(voiced.mean()) if len(values) else 0.0
        agreement = float((pitch_class_distance(values[voiced], note["midi"]) <= 0.7).sum() / len(values)) if len(values) else 0.0
        evidence = note.setdefault("evidence", {})
        evidence["alternateVoicedRatio"] = round(support, 2)
        evidence["alternatePitchAgreement"] = round(agreement, 2)
        if alternate_dominance is not None:
            evidence["alternateVocalDominanceDb"] = round(
                float(np.median(alternate_dominance[a:b])), 1
            )
        reasons = note.setdefault("reviewReasons", [])
        if support < 0.35:
            reason = "weak support from alternate separator"
            if reason not in reasons:
                reasons.append(reason)
        elif agreement < 0.25:
            reason = "separators disagree on pitch"
            if reason not in reasons:
                reasons.append(reason)
        if reasons:
            flagged += 1
    return flagged


def recover_consensus_notes(primary):
    """Recover quiet vocals only when two independent separations agree."""
    notes = primary.get("notes", [])
    rejected = primary.get("rejectedNotes", [])
    recovered, remaining = [], []
    for note in rejected:
        e = note.get("evidence", {})
        consensus = (
            note.get("reason") == "possible accompaniment leakage"
            and e.get("alternateVoicedRatio", 0) >= 0.70
            and e.get("alternatePitchAgreement", 0) >= 0.60
            and e.get("alternateVocalDominanceDb", -999) >= -14.0
        )
        if consensus:
            restored = dict(note)
            restored.pop("reason", None)
            restored["recoveredBy"] = "dual-separator consensus"
            recovered.append(restored)
        else:
            remaining.append(note)
    notes.extend(recovered)
    notes.sort(key=lambda n: (n["start"], n["end"]))
    primary["notes"] = notes
    primary["rejectedNotes"] = remaining
    return len(recovered)


def main():
    primary_path, alternate_path = sys.argv[1:3]
    primary = json.load(open(primary_path))
    alternate = json.load(open(alternate_path))
    if abs(primary["hopSeconds"] - alternate["hopSeconds"]) > 1e-9:
        raise ValueError("maps use different hop sizes")
    if abs(primary["durationSeconds"] - alternate["durationSeconds"]) > 0.05:
        raise ValueError("maps are not time-aligned")
    alt_dom = np.asarray(alternate["dominanceDb"]) if "dominanceDb" in alternate else None
    flagged = annotate(primary.get("notes", []), alternate["midi"], alt_dom, primary["hopSeconds"])
    annotate(primary.get("rejectedNotes", []), alternate["midi"], alt_dom, primary["hopSeconds"])
    recovered = recover_consensus_notes(primary)
    primary["comparison"] = {
        "alternate": alternate_path,
        "reviewFlaggedNotes": flagged,
        "consensusRecoveredNotes": recovered,
    }
    with open(primary_path, "w") as fh:
        json.dump(primary, fh, separators=(",", ":"))
    print(f"attached alternate-separator evidence; recovered {recovered} consensus notes; "
          f"{flagged} playable notes flagged for diagnostics")


if __name__ == "__main__":
    main()
