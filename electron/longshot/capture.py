"""Screen region capture using mss, with frame deduplication."""
import time
import hashlib
import mss
import numpy as np


class CaptureEngine:
    """Captures a screen region and tracks frames, only saving when content changes."""

    def __init__(self, region: dict):
        """
        region: dict with keys 'left', 'top', 'width', 'height' in screen pixels.
        """
        self._region = region
        self._sct = mss.mss()
        self._frames: list[np.ndarray] = []
        self._hashes: list[str] = []
        self._running = False
        self._interval = 200  # ms

    @property
    def frame_count(self) -> int:
        return len(self._frames)

    @property
    def frames(self) -> list[np.ndarray]:
        return self._frames

    @property
    def running(self) -> bool:
        return self._running

    def start(self):
        self._running = True

    def stop(self):
        self._running = False

    def tick(self) -> bool:
        """
        Capture one frame. Returns True if a NEW frame was added (content changed).
        Call this on a timer.
        """
        if not self._running:
            return False

        img = self._capture_one()
        if img is None:
            return False

        h = self._hash_frame(img)
        if h in self._hashes:
            return False

        self._frames.append(img)
        self._hashes.append(h)
        return True

    def _capture_one(self) -> np.ndarray | None:
        try:
            sct_img = self._sct.grab(self._region)
            return np.array(sct_img)[:, :, :3]  # BGRA → BGR
        except Exception:
            return None

    @staticmethod
    def _hash_frame(img: np.ndarray) -> str:
        """Fast perceptual hash for dedup — compare downscaled center strip."""
        h, w = img.shape[:2]
        strip = img[h // 3 : 2 * h // 3, w // 4 : 3 * w // 4]
        small = strip[::4, ::4]
        return hashlib.md5(small.tobytes()).hexdigest()

    def interval_ms(self) -> int:
        return self._interval
