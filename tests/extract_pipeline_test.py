import json
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extract"))
from compare_maps import annotate, recover_consensus_notes
from beats import detect as detect_beats
from segment_notes import apply_overrides, validate_notes


class ExtractPipelineTests(unittest.TestCase):
    def test_reviewed_chart_replaces_generated_notes(self):
        payload = {
            "version": 1,
            "replace": [
                {"start": 1.0, "end": 1.4, "midi": 60},
                {"start": 1.4, "end": 1.8, "midi": 62},
            ],
        }
        with tempfile.NamedTemporaryFile("w", suffix=".json") as fh:
            json.dump(payload, fh)
            fh.flush()
            notes, edited, added = apply_overrides([], fh.name)
        self.assertEqual([n["name"] for n in notes], ["C4", "D4"])
        self.assertEqual((edited, added), (2, 0))

    def test_reviewed_chart_rejects_overlaps(self):
        with self.assertRaises(ValueError):
            validate_notes([
                {"start": 1.0, "end": 1.5},
                {"start": 1.4, "end": 1.8},
            ])

    def test_alternate_separator_evidence_flags_disagreement(self):
        notes = [{"start": 0, "end": 0.04, "midi": 60}]
        flagged = annotate(notes, [67.0, 67.1, None, None], None, 0.01)
        self.assertEqual(flagged, 1)
        self.assertEqual(notes[0]["evidence"]["alternateVoicedRatio"], 0.5)
        self.assertIn("separators disagree on pitch", notes[0]["reviewReasons"])

    def test_two_separators_can_recover_a_quiet_matching_vocal(self):
        payload = {"notes": [], "rejectedNotes": [{
            "start": 1.0, "end": 1.2, "midi": 60,
            "reason": "possible accompaniment leakage",
            "evidence": {
                "alternateVoicedRatio": .9,
                "alternatePitchAgreement": .8,
                "alternateVocalDominanceDb": -8,
            },
        }]}
        self.assertEqual(recover_consensus_notes(payload), 1)
        self.assertEqual(len(payload["notes"]), 1)
        self.assertEqual(payload["notes"][0]["recoveredBy"], "dual-separator consensus")

    def test_beat_grid_tracks_regular_pulses(self):
        sr, hop, bpm = 8000, 80, 120
        x = np.zeros(sr * 8)
        for t in np.arange(0.25, 8, 60 / bpm):
            i = int(t * sr)
            x[i:i + 80] += np.hanning(80)
        beats = detect_beats(x, sr, hop)
        self.assertGreater(len(beats), 10)
        self.assertAlmostEqual(float(np.median(np.diff(beats))), 0.5, delta=0.04)


if __name__ == "__main__":
    unittest.main()
