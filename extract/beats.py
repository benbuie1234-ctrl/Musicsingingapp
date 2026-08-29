"""Small dependency-free beat grid for gameplay visuals.

This is not used for pitch extraction or scoring. It estimates a steady pulse
from accompaniment spectral flux so measure shading scrolls with the music.
"""
import numpy as np

from onsets import spectral_flux


def detect(x, sr, hop, min_bpm=70, max_bpm=190):
    env = spectral_flux(x, sr, hop)
    if len(env) < 16 or not np.isfinite(env).all():
        return []
    env = np.maximum(env - np.percentile(env, 55), 0.0)
    scale = np.percentile(env, 95)
    if scale <= 1e-9:
        return []
    env = np.minimum(env / scale, 3.0)
    hop_sec = hop / sr
    lag_lo = max(2, int(round(60 / max_bpm / hop_sec)))
    lag_hi = min(len(env) // 3, int(round(60 / min_bpm / hop_sec)))
    scores = []
    for lag in range(lag_lo, lag_hi + 1):
        a, b = env[:-lag], env[lag:]
        scores.append(float(np.dot(a, b) / max(1, len(a))))
    lag = lag_lo + int(np.argmax(scores))

    # Pick the phase whose predicted pulses carry the strongest onset energy.
    phase_scores = [float(env[p::lag].sum()) for p in range(lag)]
    phase = int(np.argmax(phase_scores))
    predicted = np.arange(phase, len(env), lag)
    radius = max(2, int(round(0.055 / hop_sec)))
    beats = []
    for p in predicted:
        lo, hi = max(0, p - radius), min(len(env), p + radius + 1)
        beats.append(lo + int(np.argmax(env[lo:hi])))
    beats = np.array(sorted(set(beats)), dtype=int)
    if len(beats) < 8:
        return []

    # Align alternating four-beat measure bands to the strongest beat class.
    strengths = [float(env[beats[k::4]].mean()) for k in range(4)]
    beats = beats[int(np.argmax(strengths)):]
    return [round(float(i * hop_sec), 3) for i in beats]
