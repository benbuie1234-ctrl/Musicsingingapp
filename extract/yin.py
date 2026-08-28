"""YIN fundamental-frequency estimation.

Deliberately kept simple and dependency-light: the browser side reimplements
this same algorithm on live mic input, and keeping the two in lockstep means
whatever bias YIN has applies equally to the target and the performance, so
it cancels in the comparison instead of reading as pitch error.

Reference: de Cheveigne & Kawahara (2002).
"""
import numpy as np

FMIN = 65.0     # ~C2, below any sung fundamental we care about
FMAX = 1200.0   # ~D6, above it
THRESHOLD = 0.15


def _difference(frames, tau_max):
    """Cumulative-mean-normalized difference function, batched over frames."""
    n, w = frames.shape
    # d(tau) = pow(0..w-tau) + pow(tau..w) - 2*corr(tau), corr via FFT
    size = 1 << (2 * w - 1).bit_length()
    fft = np.fft.rfft(frames, size)
    corr = np.fft.irfft(fft * np.conjugate(fft), size)[:, :tau_max]

    cumsq = np.concatenate(
        [np.zeros((n, 1)), np.cumsum(frames ** 2, axis=1)], axis=1
    )
    total = cumsq[:, w][:, None]
    tau = np.arange(tau_max)
    head = cumsq[:, w - tau]                  # energy of x[0 : w-tau]
    tail = total - cumsq[:, tau]              # energy of x[tau : w]
    d = head + tail - 2 * corr

    # cumulative mean normalization; d'(0) = 1 by definition
    d = np.maximum(d, 0.0)
    cumulative = np.cumsum(d[:, 1:], axis=1)
    denom = cumulative / np.maximum(tau[1:], 1)
    # A silent frame has d == 0 for every tau. Dividing that by a tiny floor
    # would score it as perfectly periodic, so such frames are pinned to 1.0
    # (maximally aperiodic) and get rejected by the voicing gate downstream.
    dprime = np.ones_like(d)
    np.divide(d[:, 1:], denom, out=dprime[:, 1:], where=denom > 1e-12)
    return dprime


def _absolute_threshold(dprime, tau_min, threshold):
    """First local minimum below `threshold`; else the global minimum."""
    n, tau_max = dprime.shape
    search = dprime[:, tau_min:]
    below = search < threshold

    taus = np.full(n, -1, dtype=np.int64)
    # first index below threshold, per frame
    has = below.any(axis=1)
    first = np.argmax(below, axis=1)
    # walk down to the actual local minimum of that dip
    for i in np.nonzero(has)[0]:
        j = first[i]
        while j + 1 < search.shape[1] and search[i, j + 1] < search[i, j]:
            j += 1
        taus[i] = j + tau_min
    # frames with no dip below threshold: fall back to global min
    if (~has).any():
        taus[~has] = np.argmin(search[~has], axis=1) + tau_min
    return taus, has


def _parabolic(dprime, taus):
    """Sub-sample refinement of each minimum by parabolic interpolation."""
    n, tau_max = dprime.shape
    out = taus.astype(np.float64)
    ok = (taus > 0) & (taus < tau_max - 1)
    idx = np.nonzero(ok)[0]
    t = taus[idx]
    a = dprime[idx, t - 1]
    b = dprime[idx, t]
    c = dprime[idx, t + 1]
    denom = 2.0 * (2.0 * b - a - c)
    shift = np.where(np.abs(denom) > 1e-12, (c - a) / np.where(np.abs(denom) > 1e-12, denom, 1), 0.0)
    out[idx] = t + np.clip(shift, -1.0, 1.0)
    return out


def track(x, sr, hop, frame=2048, fmin=FMIN, fmax=FMAX, threshold=THRESHOLD):
    """Return (f0_hz, aperiodicity, rms) per frame. f0 is 0.0 where unvoiced."""
    tau_min = max(2, int(sr / fmax))
    tau_max = min(frame // 2, int(sr / fmin) + 2)

    n = 1 + max(0, (len(x) - frame) // hop)
    idx = np.arange(frame)[None, :] + hop * np.arange(n)[:, None]
    frames = x[idx].astype(np.float64)

    rms = np.sqrt((frames ** 2).mean(axis=1))
    frames = frames - frames.mean(axis=1, keepdims=True)

    f0 = np.zeros(n)
    aper = np.ones(n)
    # chunk to keep FFT memory bounded on long files
    step = 2048
    for s in range(0, n, step):
        e = min(s + step, n)
        dprime = _difference(frames[s:e], tau_max)
        taus, has = _absolute_threshold(dprime, tau_min, threshold)
        refined = _parabolic(dprime, taus)
        f0[s:e] = np.where(refined > 0, sr / np.maximum(refined, 1e-9), 0.0)
        aper[s:e] = dprime[np.arange(e - s), taus]
        f0[s:e] = np.where(has, f0[s:e], 0.0)
    return f0, aper, rms
