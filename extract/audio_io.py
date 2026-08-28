"""Audio loading via ffmpeg, so any format Apple Music hands us just works."""
import subprocess
import numpy as np


def load_mono(path, sr=44100):
    """Decode `path` to a mono float32 numpy array at `sr`."""
    cmd = [
        "ffmpeg", "-v", "error", "-i", str(path),
        "-f", "f32le", "-acodec", "pcm_f32le",
        "-ac", "1", "-ar", str(sr), "-",
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed on {path}:\n{proc.stderr.decode()[:500]}")
    return np.frombuffer(proc.stdout, dtype=np.float32).astype(np.float64), sr
