import { useEffect, useRef, useState } from 'react';
import type { PdfStroke } from './PdfAnnotation/PdfTypes';
import { releaseStreamingInk } from './PdfAnnotation/StreamingInkStroke';
import { distance, scaleShape, shapeCenter, withShape, type InkShapeGeometry, type ShapePoint } from './InkShapeGeometry';
import { recognizeInkShape } from './InkShapeRecognition';
import { useInkShapePreferences } from './InkShapePreferences';

interface GestureBridge {
  scope: string; enabled: boolean; delay: number; zoom: number;
  getScope: () => string;
  getStroke: () => PdfStroke | null;
  setStroke: (stroke: PdfStroke) => void;
  flush: () => void;
  repaint: () => void;
}
/** One bounded timer per owned stroke. No React/store writes on raw samples. */
export class InkShapeHold {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private anchor: ShapePoint | null = null;
  private scope = '';
  private id = '';
  private original: PdfStroke | null = null;
  private fitted: InkShapeGeometry | null = null;
  private heldAt: ShapePoint | null = null;
  private blocked = false;
  constructor(private read: () => GestureBridge) {}
  stopTimer() { clearTimeout(this.timer); this.timer = undefined; }
  begin(screen: ShapePoint, pointerType: string) {
    this.reset();
    const b = this.read(), stroke = b.getStroke();
    if (!b.enabled || pointerType === 'touch' || !stroke || stroke.compositeOperation !== 'source-over') return;
    this.id = stroke.id; this.scope = b.scope; this.anchor = screen;
    this.arm();
  }
  private valid(b = this.read()) { return b.enabled && b.scope === this.scope && b.getScope() === this.scope && b.getStroke()?.id === this.id; }
  private arm() {
    this.stopTimer();
    if (this.blocked || !this.anchor) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const b = this.read();
      if (!this.valid(b)) return;
      b.flush();
      const stroke = b.getStroke();
      if (!stroke || stroke.geometry) return;
      const fitted = recognizeInkShape(stroke.points, b.zoom);
      if (!fitted) return;
      this.original = { ...stroke, points: stroke.points.slice() };
      this.fitted = fitted; this.heldAt = stroke.points[stroke.points.length - 1];
      releaseStreamingInk(stroke);
      b.setStroke(withShape(stroke, fitted)); b.repaint();
    }, this.read().delay);
  }
  move(screen: ShapePoint, world: ShapePoint): boolean {
    const b = this.read();
    if (!this.valid(b)) { this.reset(); return false; }
    if (this.fitted && this.heldAt) {
      const center = shapeCenter(this.fitted);
      const geometry: InkShapeGeometry = this.fitted.kind === 'line' ? { ...this.fitted, b: world }
        : scaleShape(this.fitted, distance(world, center) / Math.max(0.1, distance(this.heldAt, center)));
      b.setStroke(withShape(b.getStroke()!, geometry)); b.repaint(); return true;
    }
    if (this.anchor && distance(screen, this.anchor) > 4) { this.anchor = screen; this.arm(); }
    return false;
  }
  restore() {
    this.stopTimer(); this.blocked = true;
    if (this.original && this.valid()) { this.read().setStroke(this.original); this.read().repaint(); }
    this.fitted = null; this.original = null;
  }
  finish(stroke: PdfStroke | null): PdfStroke | null {
    const raw = stroke?.geometry && stroke.id === this.id && this.valid() ? this.original : null;
    this.reset(); return raw;
  }
  reset() { this.stopTimer(); this.anchor = null; this.original = null; this.fitted = null; this.heldAt = null; this.blocked = false; this.id = ''; }
}

export function useInkShapeGesture(options: Omit<GestureBridge, 'delay' | 'zoom'> & { zoom: () => number }) {
  const delay = useInkShapePreferences(s => s.delay), preferenceEnabled = useInkShapePreferences(s => s.enabled);
  const latest = useRef(options); latest.current = options;
  const prefs = useRef({ delay, preferenceEnabled }); prefs.current = { delay, preferenceEnabled };
  const hold = useRef<InkShapeHold>();
  if (!hold.current) hold.current = new InkShapeHold(() => ({ ...latest.current, zoom: latest.current.zoom(),
    enabled: latest.current.enabled && prefs.current.preferenceEnabled, delay: prefs.current.delay }));
  const [recent, setRecent] = useState<PdfStroke | null>(null);
  useEffect(() => {
    hold.current!.stopTimer(); setRecent(null);
  }, [options.scope, options.enabled, preferenceEnabled, delay]);
  useEffect(() => {
    const blur = () => hold.current!.stopTimer();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') hold.current!.restore(); };
    window.addEventListener('blur', blur); window.addEventListener('keydown', key);
    return () => { hold.current!.reset(); window.removeEventListener('blur', blur); window.removeEventListener('keydown', key); };
  }, []);
  return {
    begin: (screen: ShapePoint, pointerType: string) => { setRecent(null); hold.current!.begin(screen, pointerType); },
    move: (screen: ShapePoint, world: ShapePoint) => hold.current!.move(screen, world),
    finish: (stroke: PdfStroke | null) => { const raw = hold.current!.finish(stroke); if (raw) setRecent(raw); },
    stop: () => hold.current!.stopTimer(),
    dismiss: () => setRecent(null),
    recent,
  };
}
