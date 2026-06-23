"""Stitch frames vertically — JSON stdin/stdout interface."""
import sys, json, cv2, numpy as np, base64

def load(d):
    b64=d.split(',',1)[1]; return cv2.imdecode(np.frombuffer(base64.b64decode(b64),np.uint8), cv2.IMREAD_COLOR)

args=json.loads(sys.stdin.read()) if not sys.stdin.isatty() else {}
images=[load(i) for i in args.get('images',[])]; offsets=args.get('offsets',[])
if not images: print(json.dumps({"ok":False,"error":"no images"})); sys.exit(1)

mw=max(i.shape[1] for i in images); th=max(offsets[i]+images[i].shape[0] for i in range(len(images)))
canvas=np.zeros((th,mw,3),dtype=np.uint8)
for i,(img,off) in enumerate(zip(images,offsets)):
    h,w=img.shape[:2]; canvas[off:off+h,:w]=img

_,buf=cv2.imencode('.png',canvas); b64=base64.b64encode(buf).decode()
print(json.dumps({"ok":True,"dataUrl":f"data:image/png;base64,{b64}","width":mw,"height":th}))
