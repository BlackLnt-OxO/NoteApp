"""Align frames via overlap detection — JSON stdin/stdout interface."""
import sys, json, cv2, numpy as np, base64

def load(d):
    b64=d.split(',',1)[1]; return cv2.imdecode(np.frombuffer(base64.b64decode(b64),np.uint8), cv2.IMREAD_COLOR)

def find_overlap(prev, curr):
    pg=cv2.cvtColor(prev,cv2.COLOR_BGR2GRAY); cg=cv2.cvtColor(curr,cv2.COLOR_BGR2GRAY)
    mx=int(prev.shape[1]*0.06); pg=pg[:,mx:-mx] if mx>0 else pg; cg=cg[:,mx:-mx] if mx>0 else cg
    mh=min(prev.shape[0],curr.shape[0])
    lo,hi=max(5,int(mh*0.03)),int(mh*0.98)  # wider search range for fast/slow scroll
    best=lo; bs=float('inf'); step=max(1,(hi-lo)//100)  # finer steps
    for ov in range(lo,hi,step):
        if ov>prev.shape[0] or ov>curr.shape[0]: break
        s=float(cv2.absdiff(pg[-ov:,:],cg[:ov,:]).mean())
        if s<bs: bs=s; best=ov
    # If match quality is poor, use a minimal overlap to avoid gaps
    if bs>25: return max(5, lo)
    # Min advance: prevent near-exact duplicate frames
    if best<3: best=3
    return best

args=json.loads(sys.stdin.read()) if not sys.stdin.isatty() else {}
images=args.get('images',[]); imgs=[load(i) for i in images]; offsets=[0]
for i in range(1,len(imgs)):
    ov=find_overlap(imgs[i-1],imgs[i]); offsets.append(offsets[-1]+imgs[i-1].shape[0]-ov)
print(json.dumps({"ok":True,"alignments":[{"offset":o} for o in offsets]}))
