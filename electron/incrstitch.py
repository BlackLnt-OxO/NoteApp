"""Incremental stitch: overlap detection + append to cumulative file."""
import sys, json, cv2, numpy as np, base64, os

def load(d):
    b64 = d.split(',', 1)[1]
    return cv2.imdecode(np.frombuffer(base64.b64decode(b64), np.uint8), cv2.IMREAD_COLOR)

def find_overlap(prev, curr):
    pg = cv2.cvtColor(prev, cv2.COLOR_BGR2GRAY)
    cg = cv2.cvtColor(curr, cv2.COLOR_BGR2GRAY)
    h, w = pg.shape

    strip_h = max(20, min(int(cg.shape[0] * 0.25), cg.shape[0]))
    template = cg[:strip_h, :]

    result = cv2.matchTemplate(pg, template, cv2.TM_CCOEFF_NORMED)
    _, max_val, _, max_loc = cv2.minMaxLoc(result)

    match_y = max_loc[1]
    overlap = h - match_y

    if overlap <= 0 or max_val < 0.5:
        overlap = max(3, int(h * 0.02))
    if overlap > cg.shape[0]:
        overlap = cg.shape[0]

    return overlap

args = json.loads(sys.stdin.read()) if not sys.stdin.isatty() else {}
prev = load(args['prev'])
curr = load(args['curr'])
cum_path = args.get('cum_path', '')

overlap = find_overlap(prev, curr)
unique = curr[overlap:, :, :]

if cum_path and os.path.exists(cum_path):
    cum = cv2.imread(cum_path)
    if cum is not None and unique.shape[0] > 0:
        cum = np.vstack([cum, unique])
    elif cum is None:
        cum = unique
else:
    cum = unique

cv2.imwrite(cum_path, cum)
h, w = cum.shape[:2]
print(json.dumps({"ok": True, "overlap": overlap, "cumH": h, "cumW": w}))
