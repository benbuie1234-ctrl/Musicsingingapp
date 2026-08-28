"""Syllable onset detection on an isolated vocal.

Pitch alone cannot tell you where one note ends and the next begins when a
singer repeats the same note across several syllables -- "LAY-ING IN MY BED" is
one flat line to a pitch tracker, and one long block on screen, when it should
be four. Each syllable does however restart the vocal's energy, so spectral flux
finds the boundaries that pitch cannot.
"""
import numpy as np

N_FFT = 2048


def spectral_flux(x, sr, hop, n_fft=N_FFT):
    """Half-wave rectified spectral difference, one value per frame."""
    n = 1 + max(0, (len(x) - n_fft) // hop)
    win = np.hanning(n_fft)
    flux = np.zeros(n)
    prev = None
    for s in range(0, n, 512):                      # chunked to bound memory
        e = min(s + 512, n)
        idx = np.arange(n_fft)[None, :] + hop * np.arange(s, e)[:, None]
        mag = np.abs(np.fft.rfft(x[idx] * win, axis=1))
        mag = np.log1p(mag * 100.0)                 # compress, so loud parts don't dominate
        # the very first frame has nothing to differ from, so it pairs with itself
        block = np.vstack([mag[:1] if prev is None else prev, mag])
        diff = np.diff(block, axis=0)
        flux[s:e] = np.maximum(diff, 0).sum(axis=1)[-(e - s):]
        prev = mag[-1:]
    if n:
        flux[0] = 0.0
    return flux


def pick_peaks(flux, hop_sec, min_gap_ms=95, context_ms=350, delta=0.55):
    """Local maxima that clear an adaptive local threshold."""
    if len(flux) == 0:
        return np.array([], dtype=int)
    # light smoothing so a single noisy frame is not an onset
    k = np.ones(3) / 3.0
    sm = np.convolve(flux, k, mode="same")

    ctx = max(3, int(context_ms / 1000 / hop_sec))
    pad = np.pad(sm, ctx, mode="edge")
    local = np.array([pad[i:i + 2 * ctx + 1].mean() for i in range(len(sm))])
    spread = np.array([pad[i:i + 2 * ctx + 1].std() for i in range(len(sm))])
    thresh = local + delta * spread

    gap = max(1, int(min_gap_ms / 1000 / hop_sec))
    peaks = []
    for i in range(1, len(sm) - 1):
        if sm[i] < thresh[i]:
            continue
        if sm[i] < sm[i - 1] or sm[i] < sm[i + 1]:
            continue
        if peaks and i - peaks[-1] < gap:
            # keep whichever of the two is stronger
            if sm[i] > sm[peaks[-1]]:
                peaks[-1] = i
            continue
        peaks.append(i)
    return np.array(peaks, dtype=int)


def detect(x, sr, hop):
    """Frame indices where a new syllable appears to start."""
    return pick_peaks(spectral_flux(x, sr, hop), hop / sr)
