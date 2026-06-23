"""Vertical long-screenshot stitcher using overlap search (no OpenCV Stitcher)."""
import numpy as np
import cv2


class Stitcher:
    """
    Stitches a list of frames vertically.
    Uses adjacent-frame overlap search on grayscale images.
    """

    def __init__(self, margin_pct: float = 0.08, min_overlap_pct: float = 0.15,
                 max_overlap_pct: float = 0.90, min_confidence: float = 8.0):
        self.margin_pct = margin_pct      # Ignore left/right edges
        self.min_overlap = min_overlap_pct
        self.max_overlap = max_overlap_pct
        self.min_confidence = min_confidence  # Lower = better match (mean absdiff)
        self.warnings: list[str] = []

    def stitch(self, frames: list[np.ndarray]) -> np.ndarray | None:
        """Stitch frames vertically. Returns combined BGR image or None."""
        if not frames:
            return None
        if len(frames) == 1:
            return frames[0]

        self.warnings = []
        offsets = [0]
        for i in range(1, len(frames)):
            dy = self._find_overlap(frames[i - 1], frames[i], i)
            offsets.append(offsets[-1] + dy)

        max_w = max(f.shape[1] for f in frames)
        total_h = max(offsets[i] + frames[i].shape[0] for i in range(len(frames)))

        canvas = np.zeros((total_h, max_w, 3), dtype=np.uint8)
        for i, (f, off) in enumerate(zip(frames, offsets)):
            h, w = f.shape[:2]
            canvas[off:off + h, :w] = f

        return canvas

    def _find_overlap(self, prev: np.ndarray, curr: np.ndarray, idx: int) -> int:
        """
        Find vertical pixel offset between prev (top) and curr (bottom).
        Returns dy — how many pixels to advance before placing curr.
        Lower dy = more overlap, higher dy = less overlap.
        """
        ph, pw = prev.shape[:2]
        ch, cw = curr.shape[:2]

        # Convert to grayscale
        pg = cv2.cvtColor(prev, cv2.COLOR_BGR2GRAY) if prev.ndim == 3 else prev
        cg = cv2.cvtColor(curr, cv2.COLOR_BGR2GRAY) if curr.ndim == 3 else curr

        # Ignore left/right margins
        mx = int(pw * self.margin_pct)
        pg = pg[:, mx:pw - mx]
        cg = cg[:, mx:cw - mx]

        min_h = min(ph, ch)
        min_ov = max(20, int(min_h * self.min_overlap))
        max_ov = int(min_h * self.max_overlap)

        best_overlap = min_ov
        best_score = float('inf')

        for ov in range(min_ov, max_ov, max(1, (max_ov - min_ov) // 40)):
            if ov > ph or ov > ch:
                break
            prev_strip = pg[ph - ov:ph, :]
            curr_strip = cg[:ov, :]
            if prev_strip.shape != curr_strip.shape:
                continue
            score = float(cv2.absdiff(prev_strip, curr_strip).mean())
            if score < best_score:
                best_score = score
                best_overlap = ov

        if best_score > self.min_confidence:
            self.warnings.append(
                f"Frame {idx}: low match confidence ({best_score:.1f}), "
                f"using default offset (overlap={best_overlap})"
            )

        return ph - best_overlap
