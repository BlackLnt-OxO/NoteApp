"""Diagnostic incremental stitch: file-path input, overlap detection, append to cumulative, generate preview tile.
Variant of incrstitch.py with:
- File path input instead of base64 (avoids large base64 in IPC/stdin)
- Optional low-res preview tile generation
- Detailed timing info in output
- JSON stdin/stdout interface
"""
import sys, json, cv2, numpy as np, os, time


def load_from_file(filepath):
    """Load image from file path (BGR)."""
    img = cv2.imread(filepath, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"Cannot read image: {filepath}")
    return img


def load_from_base64(d):
    """Load image from base64 data URL."""
    import base64
    b64 = d.split(',', 1)[1]
    return cv2.imdecode(np.frombuffer(base64.b64decode(b64), np.uint8), cv2.IMREAD_COLOR)


def find_overlap(prev, curr):
    """
    Find vertical overlap between prev (top) and curr (bottom) using template matching.
    Returns overlap pixel count.
    """
    pg = cv2.cvtColor(prev, cv2.COLOR_BGR2GRAY)
    cg = cv2.cvtColor(curr, cv2.COLOR_BGR2GRAY)
    h, w = pg.shape

    # Use top strip of curr as template, search in prev
    strip_h = max(20, min(int(cg.shape[0] * 0.25), cg.shape[0]))
    template = cg[:strip_h, :]

    # Template matching
    result = cv2.matchTemplate(pg, template, cv2.TM_CCOEFF_NORMED)
    _, max_val, _, max_loc = cv2.minMaxLoc(result)

    match_y = max_loc[1]
    overlap = h - match_y

    # Sanity checks
    if overlap <= 0 or max_val < 0.5:
        overlap = max(3, int(h * 0.02))
    if overlap > cg.shape[0]:
        overlap = cg.shape[0]

    return overlap, float(max_val)


def save_preview_tile(tile_img, preview_dir, tile_index, preview_width=220):
    """
    Resize a tile to preview width and save as a preview tile file.
    Returns the tile file path.
    """
    h, w = tile_img.shape[:2]
    if w == 0 or h == 0:
        return None

    scale = preview_width / w
    new_h = max(1, int(h * scale))
    resized = cv2.resize(tile_img, (preview_width, new_h), interpolation=cv2.INTER_AREA)

    tile_path = os.path.join(preview_dir, f"preview-tile-{tile_index:04d}.png")
    cv2.imwrite(tile_path, resized)
    return tile_path


def stitch_incremental(prev_path_or_b64, curr_path_or_b64, cum_path, preview_dir=None, preview_width=220, use_file_paths=False):
    """
    Core incremental stitch logic. Returns dict with result info.

    Args:
        prev_path_or_b64: Previous frame (file path or base64 data URL)
        curr_path_or_b64: Current frame (file path or base64 data URL)
        cum_path: Path to cumulative output PNG
        preview_dir: Optional directory for preview tiles
        preview_width: Width for preview tiles
        use_file_paths: If True, treat prev/curr as file paths instead of base64
    """
    t0 = time.time()

    # Load images
    load_t0 = time.time()
    if use_file_paths:
        prev = load_from_file(prev_path_or_b64)
        curr = load_from_file(curr_path_or_b64)
    else:
        prev = load_from_base64(prev_path_or_b64)
        curr = load_from_base64(curr_path_or_b64)
    load_ms = (time.time() - load_t0) * 1000

    # Find overlap
    overlap_t0 = time.time()
    overlap, confidence = find_overlap(prev, curr)
    overlap_ms = (time.time() - overlap_t0) * 1000

    # Extract unique portion of curr
    unique = curr[overlap:, :, :]

    # Load cumulative image
    cum_t0 = time.time()
    if os.path.exists(cum_path):
        cum = cv2.imread(cum_path)
        if cum is not None and unique.shape[0] > 0:
            old_h = cum.shape[0]
            cum = np.vstack([cum, unique])
            new_h = cum.shape[0]
        elif cum is None:
            cum = unique
            old_h = 0
            new_h = unique.shape[0]
        else:
            old_h = cum.shape[0]
            new_h = old_h
    else:
        cum = unique
        old_h = 0
        new_h = unique.shape[0]

    # Save cumulative
    save_t0 = time.time()
    cv2.imwrite(cum_path, cum)
    save_ms = (time.time() - save_t0) * 1000

    cum_h, cum_w = cum.shape[:2]

    # Generate preview tile if requested
    preview_tile_path = None
    preview_ms = 0
    if preview_dir and unique.shape[0] > 0:
        preview_t0 = time.time()
        os.makedirs(preview_dir, exist_ok=True)
        # Find existing preview tiles to determine next index
        existing_tiles = [f for f in os.listdir(preview_dir) if f.startswith('preview-tile-')]
        tile_index = len(existing_tiles) + 1
        preview_tile_path = save_preview_tile(unique, preview_dir, tile_index, preview_width)
        preview_ms = (time.time() - preview_t0) * 1000

    total_ms = (time.time() - t0) * 1000

    return {
        "ok": True,
        "overlap": int(overlap),
        "confidence": round(float(confidence), 4),
        "cumH": cum_h,
        "cumW": cum_w,
        "oldCumH": old_h,
        "uniqueH": unique.shape[0],
        "uniqueW": unique.shape[1],
        "timing": {
            "loadMs": round(load_ms, 2),
            "overlapMs": round(overlap_ms, 2),
            "saveMs": round(save_ms, 2),
            "previewMs": round(preview_ms, 2),
            "totalMs": round(total_ms, 2),
        },
        "previewTilePath": preview_tile_path,
    }


def main():
    args = json.loads(sys.stdin.read()) if not sys.stdin.isatty() else {}

    use_file_paths = args.get('useFilePaths', False)
    prev = args['prev']
    curr = args['curr']
    cum_path = args.get('cumPath', '')
    preview_dir = args.get('previewDir', None)
    preview_width = args.get('previewWidth', 220)

    result = stitch_incremental(
        prev, curr, cum_path,
        preview_dir=preview_dir,
        preview_width=preview_width,
        use_file_paths=use_file_paths,
    )

    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
