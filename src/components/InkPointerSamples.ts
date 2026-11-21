/** Browser implementations may expose getCoalescedEvents yet return no samples. */
export function inkPointerSamples(event: PointerEvent): PointerEvent[] {
  const samples = event.getCoalescedEvents?.();
  return samples?.length ? samples : [event];
}

export interface InkPointerSample { x: number; y: number; pressure: number; t: number }

/** A gesture-local queue. No React notifications and no pointer events retained. */
export class InkPointerQueue {
  private samples: InkPointerSample[] = [];
  push(sample: InkPointerSample): void { this.samples.push(sample); }
  drain(accept: (sample: InkPointerSample) => void): number {
    const pending = this.samples;
    this.samples = [];
    for (const sample of pending) accept(sample);
    return pending.length;
  }
  clear(): void { this.samples = []; }
  get length(): number { return this.samples.length; }
}
