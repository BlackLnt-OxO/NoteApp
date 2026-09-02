import React, { useState, useRef, useCallback } from 'react';
import { fs, fsn } from '../utils';

interface Props { color: string; onChange: (c: string) => void; gfs: number; }

function hexToHsv(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1,3),16)/255, g = parseInt(hex.slice(3,5),16)/255, b = parseInt(hex.slice(5,7),16)/255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min;
  let h=0;
  if(d){
    if(max===r) h=((g-b)/d+(g<b?6:0))/6;
    else if(max===g) h=((b-r)/d+2)/6;
    else h=((r-g)/d+4)/6;
  }
  return [Math.round(h*360), Math.round(max?d/max*100:0), Math.round(max*100)];
}

function hsvToHex(h:number,s:number,v:number):string {
  const sN=s/100,vN=v/100,c=vN*sN,x=c*(1-Math.abs((h/60)%2-1)),m=vN-c;
  let r=0,g=0,b=0;
  if(h<60){r=c;g=x;}else if(h<120){r=x;g=c;}else if(h<180){g=c;b=x;}
  else if(h<240){g=x;b=c;}else if(h<300){r=x;b=c;}else{r=c;b=x;}
  const t=(n:number)=>Math.round((n+m)*255).toString(16).padStart(2,'0');
  return `#${t(r)}${t(g)}${t(b)}`;
}

// Helper: attach document-level pointer handlers, guaranteed cleanup on release
function usePointerDrag(callback: (e: PointerEvent) => void) {
  const onMove = useRef<((e: PointerEvent) => void) | null>(null);
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    callback(e.nativeEvent);
    const handler = (ev: PointerEvent) => callback(ev);
    onMove.current = handler;
    document.addEventListener('pointermove', handler);
    document.addEventListener('pointerup', () => {
      if (onMove.current) document.removeEventListener('pointermove', onMove.current);
      onMove.current = null;
    }, { once: true });
  };
  return start;
}

export const ColorPicker: React.FC<Props> = ({ color, onChange, gfs }) => {
  const [hsv, setHsv] = useState<[number,number,number]>(hexToHsv(color));
  const [h,s,v] = hsv;
  const hex = hsvToHex(h,s,v);
  const wheelRef = useRef<HTMLDivElement>(null);

  const update = useCallback((nh:number,ns:number,nv:number)=>{
    setHsv([nh,ns,nv]); onChange(hsvToHex(nh,ns,nv));
  },[onChange]);

  // Wheel drag
  const wheelDrag = useRef<(e: PointerEvent) => void | null>(null);
  const onWheelDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = wheelRef.current!;
    const rect = el.getBoundingClientRect();
    const cx=rect.width/2, cy=rect.height/2;
    const calc = (ev: PointerEvent) => {
      const dx=ev.clientX-rect.left-cx, dy=ev.clientY-rect.top-cy;
      const dist=Math.min(1,Math.sqrt(dx*dx+dy*dy)/cx);
      // CSS conic-gradient(from 90deg) uses angle CW from top (0° = top, 90° = right)
      // atan2(dx, -dy) gives exactly that: CW from top
      const cssAngle = Math.atan2(dx, -dy) / Math.PI * 180;
      const hue = ((cssAngle - 90 + 360) % 360);
      update(Math.round(hue), Math.round(dist*100), v);
    };
    calc(e.nativeEvent);
    wheelDrag.current = calc;
    document.addEventListener('pointermove', calc);
    document.addEventListener('pointerup', () => {
      if (wheelDrag.current) document.removeEventListener('pointermove', wheelDrag.current);
      wheelDrag.current = null;
    }, { once: true });
  };

  // Bar drag
  const barDrag = useCallback((cb: (ratio: number) => void) => (e: React.PointerEvent) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const calc = (ev: PointerEvent) => cb(Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height)));
    calc(e.nativeEvent);
    const h = calc;
    document.addEventListener('pointermove', h);
    document.addEventListener('pointerup', () => document.removeEventListener('pointermove', h), { once: true });
  }, []);

  // Slider drag (horizontal)
  const sliderDrag = useCallback((cb: (ratio: number) => void) => (e: React.PointerEvent) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const calc = (ev: PointerEvent) => cb(Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width)));
    calc(e.nativeEvent);
    const h = calc;
    document.addEventListener('pointermove', h);
    document.addEventListener('pointerup', () => document.removeEventListener('pointermove', h), { once: true });
  }, []);

  const startEyedropper = async () => {
    if (!window.electronAPI?.startEyedropper) return;
    const picked = await window.electronAPI.startEyedropper();
    if (picked) { onChange(picked); setHsv(hexToHsv(picked)); }
  };

  const wh = fsn(170, gfs), barW = fsn(26, gfs), barH = fsn(170, gfs);
  const rgb = [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];

  const nInput = (val:number, cb:(n:number)=>void, max=255) => (
    <input className="glass-input" type="number" min={0} max={max} value={val}
      onChange={(e)=>cb(Math.max(0,Math.min(max,parseInt(e.target.value)||0)))}
      style={{ width: fsn(54,gfs), padding:`${fs(1,gfs)} ${fs(4,gfs)}`, fontSize:fs(11,gfs), height:fsn(20,gfs), textAlign:'right', fontFamily:'monospace' }} />
  );

  return (
    <div onClick={(e)=>e.stopPropagation()} className="animate-scale-in" style={{
      background:'rgba(30,30,30,0.97)', border:'1px solid rgba(255,255,255,0.12)',
      borderRadius:fsn(8,gfs), padding:fs(12,gfs), width:fsn(480,gfs),
      boxShadow:'0 16px 48px rgba(0,0,0,0.5)',
      fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif',
    }}>
      {/* Top row */}
      <div style={{ display:'flex', gap:fs(10,gfs), marginBottom:fs(12,gfs) }}>
        {/* Color Wheel */}
        <div ref={wheelRef} onPointerDown={onWheelDown} style={{
          width:wh, height:wh, borderRadius:'50%', cursor:'crosshair', flexShrink:0,
          background:`conic-gradient(from 90deg, red, yellow, lime, cyan, blue, magenta, red)`,
          position:'relative', overflow:'hidden',
        }}>
          <div style={{ position:'absolute', inset:0, borderRadius:'50%',
            background:'radial-gradient(circle at center, white 0%, rgba(255,255,255,0) 70%)' }} />
          <div style={{ position:'absolute', pointerEvents:'none',
            left:`calc(${50+s*0.48*Math.sin((h+90)/180*Math.PI)}% - 7px)`,
            top:`calc(${50-s*0.48*Math.cos((h+90)/180*Math.PI)}% - 7px)`,
            width:14,height:14,borderRadius:'50%',
            background:hsvToHex(h,s,100),border:'2px solid #fff',boxShadow:'0 0 4px rgba(0,0,0,0.7)' }} />
        </div>

        {/* Sat bar */}
        <div onPointerDown={barDrag((r)=>update(h,Math.round((1-r)*100),v))} style={{
          position:'relative',width:barW,height:barH,borderRadius:fsn(4,gfs),cursor:'pointer',
          background:`linear-gradient(to bottom, ${hsvToHex(h,100,v)}, white)`,overflow:'hidden',
          border:'1px solid rgba(255,255,255,0.08)',
        }}>
          <div style={{ position:'absolute',left:'-2px',top:`${(1-s/100)*100}%`,
            width:fsn(barW+4,gfs),height:3,background:'#fff',transform:'translateY(-50%)',
            borderRadius:1,pointerEvents:'none',boxShadow:'0 0 2px rgba(0,0,0,0.4)' }} />
        </div>

        {/* Val bar */}
        <div onPointerDown={barDrag((r)=>update(h,s,Math.round((1-r)*100)))} style={{
          position:'relative',width:barW,height:barH,borderRadius:fsn(4,gfs),cursor:'pointer',
          background:`linear-gradient(to bottom, ${hsvToHex(h,s,100)}, black)`,overflow:'hidden',
          border:'1px solid rgba(255,255,255,0.08)',
        }}>
          <div style={{ position:'absolute',left:'-2px',top:`${(1-v/100)*100}%`,
            width:fsn(barW+4,gfs),height:3,background:'#fff',transform:'translateY(-50%)',
            borderRadius:1,pointerEvents:'none',boxShadow:'0 0 2px rgba(0,0,0,0.4)' }} />
        </div>

        {/* Old/New + Eyedropper */}
        <div style={{ display:'flex',flexDirection:'column',gap:fs(4,gfs) }}>
          <div style={{ display:'flex',gap:fs(4,gfs) }}>
            <div style={{ display:'flex',flexDirection:'column',alignItems:'center',gap:fs(2,gfs) }}>
              <span style={{ fontSize:fs(10,gfs),color:'rgba(255,255,255,0.5)' }}>旧</span>
              <div style={{ width:fsn(60,gfs),height:fsn(80,gfs),borderRadius:fsn(4,gfs),
                background:color,border:'1px solid rgba(255,255,255,0.08)' }} />
            </div>
            <div style={{ display:'flex',flexDirection:'column',alignItems:'center',gap:fs(2,gfs) }}>
              <span style={{ fontSize:fs(10,gfs),color:'rgba(255,255,255,0.5)' }}>新</span>
              <div style={{ width:fsn(60,gfs),height:fsn(80,gfs),borderRadius:fsn(4,gfs),
                background:hex,border:'1px solid rgba(255,255,255,0.08)' }} />
            </div>
          </div>
          <button onClick={startEyedropper} title="吸管取色" style={{
            background:'rgba(255,255,255,0.08)',border:'1px solid rgba(255,255,255,0.15)',
            borderRadius:fsn(4,gfs),cursor:'pointer',color:'rgba(255,255,255,0.8)',
            display:'flex',alignItems:'center',justifyContent:'center',
            width:fsn(32,gfs),height:fsn(32,gfs),fontSize:fsn(16,gfs),
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><circle cx="15" cy="6" r="3"/>
              <path d="m15 9 3.35 3.35a2 2 0 0 1 0 2.83l-.83.83a2 2 0 0 1-2.83 0L12 13.17"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Bottom: RGB + HSV sliders */}
      <div style={{ display:'flex',gap:fs(16,gfs) }}>
        {/* RGB */}
        <div style={{ flex:1,display:'flex',flexDirection:'column',gap:fs(6,gfs) }}>
          {(['R','G','B'] as const).map((label,i)=>(
            <div key={label} style={{ display:'flex',alignItems:'center',gap:fs(6,gfs) }}>
              <span style={{ fontSize:fs(11,gfs),color:'rgba(255,255,255,0.6)',width:fsn(10,gfs) }}>{label}</span>
              <div onPointerDown={sliderDrag((r)=>{
                const vals=[...rgb]; vals[i]=Math.round(r*255);
                const nh=`#${vals.map(v=>v.toString(16).padStart(2,'0')).join('')}`;
                onChange(nh);setHsv(hexToHsv(nh));
              })} style={{ flex:1,position:'relative',height:fsn(14,gfs),borderRadius:fsn(3,gfs),cursor:'pointer',
                background:i===0?`linear-gradient(to right,#000,#f00)`:i===1?`linear-gradient(to right,#000,#0f0)`:`linear-gradient(to right,#000,#00f)`,
                overflow:'hidden',boxShadow:'inset 0 1px 3px rgba(0,0,0,0.3)',
              }}>
                <div style={{ position:'absolute',top:-1,left:`${rgb[i]/255*100}%`,
                  width:6,height:fsn(16,gfs),borderRadius:2,background:'#fff',
                  border:'1px solid rgba(0,0,0,0.4)',transform:'translateX(-50%)',pointerEvents:'none' }} />
              </div>
              {nInput(rgb[i],(n)=>{const vals=[...rgb];vals[i]=n;const nh=`#${vals.map(v=>v.toString(16).padStart(2,'0')).join('')}`;onChange(nh);setHsv(hexToHsv(nh));})}
            </div>
          ))}
        </div>

        {/* HSV */}
        <div style={{ flex:1,display:'flex',flexDirection:'column',gap:fs(6,gfs) }}>
          {[
            {label:'H',val:h,max:360,bg:'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)'},
            {label:'S',val:s,max:100,bg:`linear-gradient(to right, ${hsvToHex(h,0,v)}, ${hsvToHex(h,100,v)})`},
            {label:'V',val:v,max:100,bg:`linear-gradient(to right, #000, ${hsvToHex(h,s,100)})`},
          ].map(({label,val,max,bg})=>(
            <div key={label} style={{ display:'flex',alignItems:'center',gap:fs(6,gfs) }}>
              <span style={{ fontSize:fs(11,gfs),color:'rgba(255,255,255,0.6)',width:fsn(10,gfs) }}>{label}</span>
              <div onPointerDown={sliderDrag((r)=>{
                const n=Math.round(r*max);
                if(label==='H') update(n,s,v);else if(label==='S') update(h,n,v);else update(h,s,n);
              })} style={{ flex:1,position:'relative',height:fsn(14,gfs),borderRadius:fsn(3,gfs),cursor:'pointer',
                background:bg,overflow:'hidden',boxShadow:'inset 0 1px 3px rgba(0,0,0,0.3)',
              }}>
                <div style={{ position:'absolute',top:-1,left:`${val/max*100}%`,
                  width:6,height:fsn(16,gfs),borderRadius:2,background:'#fff',
                  border:'1px solid rgba(0,0,0,0.4)',transform:'translateX(-50%)',pointerEvents:'none' }} />
              </div>
              {nInput(val,(n)=>{if(label==='H')update(n,s,v);else if(label==='S')update(h,n,v);else update(h,s,n);},max)}
            </div>
          ))}
          {/* Hex */}
          <div style={{ display:'flex',alignItems:'center',gap:fs(6,gfs),marginTop:fs(2,gfs) }}>
            <span style={{ fontSize:fs(10,gfs),color:'rgba(255,255,255,0.5)' }}>Hex sRGB</span>
            <input className="glass-input" value={hex.slice(1).toUpperCase()+'FF'}
              onChange={(e)=>{const v2='#'+e.target.value.slice(0,6);if(/^#[0-9a-fA-F]{6}$/.test(v2)){onChange(v2);setHsv(hexToHsv(v2));}}}
              style={{ flex:1,fontSize:fs(11,gfs),fontFamily:'monospace',padding:`${fs(1,gfs)} ${fs(4,gfs)}`,height:fsn(20,gfs) }} />
          </div>
        </div>
      </div>
    </div>
  );
};

export default ColorPicker;
