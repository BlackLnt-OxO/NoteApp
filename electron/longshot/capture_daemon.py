"""Long screenshot capture daemon — mss GDI capture + incremental stitch.

Communicates via JSON-lines on stdin/stdout. Spawned once per long-capture
session, eliminating Python cold-start overhead (~100-200ms) per frame.

Capture uses Win32 GDI (BitBlt) via the bundled mss library — completely
bypasses the GPU compositor pipeline, solving the desktopCapturer stutter.

Protocol (stdin → stdout, one JSON object per line):
  → {"action":"configure","cum_path":"...","region":{"left":100,"top":200,"width":500,"height":400}}
  ← {"ok":true,"message":"configured"}

  → {"action":"tick"}
  ← {"ok":true,"frame":1,"duplicate":false,"stitch_ok":true,"first_frame":true,"cumH":400,"cumW":500}

  → {"action":"finish"}
  ← {"ok":true,"finalH":3200,"finalW":500,"cumPath":"...","frameCount":15}

  → {"action":"shutdown"}
  ← {"ok":true}
"""
import sys
import json
import os
import hashlib

import cv2
import numpy as np

# ── Ensure bundled mss is importable ──────────────────────────
# In dev, the daemon is at electron/longshot/ and mss is at electron/mss/.
# In production, both are copied to the same temp directory.
_DAEMON_DIR = os.path.dirname(os.path.abspath(__file__))
_PARENT_DIR = os.path.dirname(_DAEMON_DIR)
for _p in (_DAEMON_DIR, _PARENT_DIR):
    if os.path.isdir(os.path.join(_p, "mss")) and _p not in sys.path:
        sys.path.insert(0, _p)
        break

import mss


class CaptureDaemon:
    """Persistent capture + stitch engine for long screenshots."""

    def __init__(self) -> None:
        self.region: dict | None = None
        self.cum_path: str = ""
        self.prev_frame: np.ndarray | None = None   # previous frame (BGR)
        self.prev_gray: np.ndarray | None = None    # previous frame grayscale
        self.cumulative: np.ndarray | None = None   # stitched accumulation (BGR)
        self.frame_count: int = 0
        self.sct = mss.MSS()
        self._hash_cache: set[str] = set()
        self._overlap_history: list[int] = []       # track recent overlaps for trend detection

    # ── Protocol dispatch ────────────────────────────────────

    def handle(self, msg: dict) -> dict:
        action = msg.get("action", "")
        if action == "configure":
            return self._configure(msg)
        if action == "tick":
            return self._tick()
        if action == "finish":
            return self._finish()
        if action == "shutdown":
            return {"ok": True}
        return {"ok": False, "error": f"unknown action: {action}"}

    # ── Actions ──────────────────────────────────────────────

    def _configure(self, msg: dict) -> dict:
        r = msg["region"]
        self.region = {
            "left": int(r["left"]),
            "top": int(r["top"]),
            "width": int(r["width"]),
            "height": int(r["height"]),
        }
        self.cum_path = msg.get("cum_path", "")
        self.prev_frame = None
        self.prev_gray = None
        self.cumulative = None
        self.frame_count = 0
        self._hash_cache.clear()
        self._overlap_history.clear()

        # Validate region overlaps at least one monitor
        try:
            monitors = self.sct.monitors
            region_right = self.region["left"] + self.region["width"]
            region_bottom = self.region["top"] + self.region["height"]
            valid = False
            for mon in monitors[1:]:  # monitors[0] is the virtual "all" monitor
                mon_right = mon["left"] + mon["width"]
                mon_bottom = mon["top"] + mon["height"]
                # Check for any overlap
                if (self.region["left"] < mon_right and region_right > mon["left"]
                        and self.region["top"] < mon_bottom and region_bottom > mon["top"]):
                    valid = True
                    break
            if not valid:
                return {
                    "ok": False,
                    "error": f"region {self.region} does not overlap any monitor",
                    "monitors": [{"left": m["left"], "top": m["top"],
                                  "width": m["width"], "height": m["height"]}
                                 for m in monitors[1:]],
                }
        except Exception as exc:
            return {"ok": False, "error": f"monitor enumeration failed: {exc}"}

        monitors = []
        try:
            for m in self.sct.monitors[1:]:
                monitors.append({"left": m["left"], "top": m["top"],
                                 "width": m["width"], "height": m["height"]})
        except Exception:
            pass
        return {"ok": True, "message": "configured", "region": self.region, "monitors": monitors}

    def _tick(self) -> dict:
        if self.region is None:
            return {"ok": False, "error": "not configured"}

        # Capture via mss GDI (bypasses GPU compositor)
        try:
            sct_img = self.sct.grab(self.region)
            frame = np.array(sct_img)[:, :, :3]  # BGRA → BGR
        except Exception as exc:
            return {"ok": False, "error": f"capture failed: {exc}"}

        # Dedup: skip frames identical to a previously captured one
        fhash = self._hash_frame(frame)
        if fhash in self._hash_cache:
            return {"ok": True, "frame": self.frame_count, "duplicate": True}
        self._hash_cache.add(fhash)
        self.frame_count += 1

        curr_gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

        # ── First frame → baseline ──────────────────────────
        if self.prev_frame is None:
            self.prev_frame = frame
            self.prev_gray = curr_gray
            self.cumulative = frame
            if self.cum_path:
                cv2.imwrite(self.cum_path, self.cumulative)
            return {
                "ok": True,
                "frame": self.frame_count,
                "duplicate": False,
                "stitch_ok": True,
                "first_frame": True,
                "cumH": frame.shape[0],
                "cumW": frame.shape[1],
            }

        # ── Find overlap & stitch ───────────────────────────
        overlap, confidence, method = self._find_overlap(self.prev_gray, curr_gray)
        self._overlap_history.append(overlap)
        if len(self._overlap_history) > 8:
            self._overlap_history.pop(0)

        stitch_ok = False
        if 0 < overlap < frame.shape[0]:
            unique = frame[overlap:, :, :]
            if unique.shape[0] > 0 and self.cumulative is not None:
                try:
                    self.cumulative = np.vstack([self.cumulative, unique])
                    stitch_ok = True
                except Exception:
                    stitch_ok = False
        elif overlap <= 0:
            # Complete non-overlap (major jump): append entire frame
            if self.cumulative is not None:
                try:
                    self.cumulative = np.vstack([self.cumulative, frame])
                    stitch_ok = True
                except Exception:
                    stitch_ok = False

        # Advance state
        self.prev_frame = frame
        self.prev_gray = curr_gray

        if stitch_ok and self.cum_path and self.cumulative is not None:
            cv2.imwrite(self.cum_path, self.cumulative)

        cum_h = self.cumulative.shape[0] if self.cumulative is not None else frame.shape[0]
        cum_w = self.cumulative.shape[1] if self.cumulative is not None else frame.shape[1]

        return {
            "ok": True,
            "frame": self.frame_count,
            "duplicate": False,
            "stitch_ok": stitch_ok,
            "overlap": overlap,
            "confidence": round(float(confidence), 4),
            "method": method,
            "cumH": cum_h,
            "cumW": cum_w,
        }

    def _finish(self) -> dict:
        if self.cumulative is not None and self.cum_path and os.path.exists(self.cum_path):
            return {
                "ok": True,
                "finalH": self.cumulative.shape[0],
                "finalW": self.cumulative.shape[1],
                "cumPath": self.cum_path,
                "frameCount": self.frame_count,
            }
        return {"ok": False, "error": "no cumulative image"}

    # ── Frame hashing (fast dedup) ──────────────────────────

    @staticmethod
    def _hash_frame(img: np.ndarray) -> str:
        """Perceptual hash on a downscaled center strip — fast and robust."""
        h, w = img.shape[:2]
        strip = img[h // 3: 2 * h // 3, w // 4: 3 * w // 4]
        small = strip[::4, ::4]
        return hashlib.md5(small.tobytes()).hexdigest()

    # ── Overlap detection (enhanced) ────────────────────────

    def _find_overlap(self, prev_gray: np.ndarray, curr_gray: np.ndarray) -> tuple[int, float, str]:
        """Find vertical pixel overlap between prev (older frame above) and curr (new frame below).

        Returns (overlap_pixels, confidence, method_name).
        overlap = how many rows at the TOP of curr are already present at the BOTTOM of prev.
        """
        ph, pw = prev_gray.shape
        ch, cw = curr_gray.shape

        # Width mismatch → resize curr to match prev width
        if cw != pw:
            curr_gray = cv2.resize(curr_gray, (pw, ch))
            cw = pw

        strategies: list[tuple[float, int, str]] = []

        # ── Strategy 1: matchTemplate with search window ────
        # Only search the bottom portion of prev (optimization + accuracy)
        search_start = max(0, ph - int(ch * 1.2))  # search bottom ~120% of curr height
        search_region = prev_gray[search_start:, :]

        for strip_pct in (0.15, 0.25, 0.35):
            strip_h = max(20, min(int(ch * strip_pct), ch - 2))
            template = curr_gray[:strip_h, :]

            if template.shape[0] > search_region.shape[0]:
                continue

            result = cv2.matchTemplate(search_region, template, cv2.TM_CCOEFF_NORMED)
            _, max_val, _, max_loc = cv2.minMaxLoc(result)

            # Translate match location back to full prev coordinates
            match_y = max_loc[1] + search_start
            overlap = ph - match_y

            if 5 < overlap <= ch and max_val >= 0.35:
                strategies.append((float(max_val), overlap, f"tm_{int(strip_pct*100)}pct"))

        # ── Strategy 2: absdiff exhaustive search ───────────
        min_ov = max(20, int(min(ph, ch) * 0.08))
        max_ov = int(min(ph, ch) * 0.92)
        step = max(1, (max_ov - min_ov) // 40)

        best_score = float("inf")
        best_ov = min_ov

        for ov in range(min_ov, max_ov, step):
            if ov > ph or ov > ch:
                break
            prev_strip = prev_gray[ph - ov:ph, :]
            curr_strip = curr_gray[:ov, :]
            if prev_strip.shape != curr_strip.shape:
                continue
            score = float(cv2.absdiff(prev_strip, curr_strip).mean())
            if score < best_score:
                best_score = score
                best_ov = ov

        absdiff_conf = 1.0 / (1.0 + best_score)
        strategies.append((absdiff_conf, best_ov, "absdiff"))

        # ── Pick best strategy ──────────────────────────────
        if not strategies:
            return max(5, int(ch * 0.05)), 0.0, "fallback"

        strategies.sort(key=lambda x: x[0], reverse=True)
        conf, overlap, method = strategies[0]

        # If template-match confidence is low, prefer absdiff
        if method.startswith("tm") and conf < 0.45:
            for s in strategies:
                if s[2] == "absdiff":
                    _, overlap, method = s
                    break

        # Sanity bounds
        overlap = max(5, min(overlap, ch - 1))

        # Detect scroll-direction reversal from history
        if len(self._overlap_history) >= 3:
            recent_avg = sum(self._overlap_history[-3:]) / 3
            # Overlap dropped >50% → possible direction change or fast scroll
            if recent_avg > 0 and overlap < recent_avg * 0.4:
                # Trust absdiff more in this scenario
                for s in strategies:
                    if s[2] == "absdiff":
                        _, overlap, method = s
                        break

        return overlap, conf, method


# ── Entry point ──────────────────────────────────────────────

def main() -> None:
    # Windows pipes decode with the locale ANSI codepage by default; cum_path may
    # contain non-ASCII (e.g. Windows username in %TEMP%). Force UTF-8 so the
    # JSON-lines protocol decodes identically in dev and in the frozen engine.
    for _s in (sys.stdin, sys.stdout):
        try:
            _s.reconfigure(encoding="utf-8")
        except Exception:
            pass
    daemon = CaptureDaemon()
    # Signal readiness to parent process
    print(json.dumps({"ok": True, "ready": True}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            print(json.dumps({"ok": False, "error": f"invalid json: {exc}"}), flush=True)
            continue

        try:
            response = daemon.handle(msg)
        except Exception as exc:
            # Global catch — never crash silently
            import traceback
            print(json.dumps({
                "ok": False,
                "error": f"internal error: {exc}",
                "action": msg.get("action", "?"),
                "traceback": traceback.format_exc()[:500],
            }), flush=True)
            continue

        try:
            print(json.dumps(response), flush=True)
        except BrokenPipeError:
            # Parent process closed stdout — exit gracefully
            break

        if msg.get("action") == "shutdown":
            break


if __name__ == "__main__":
    main()
