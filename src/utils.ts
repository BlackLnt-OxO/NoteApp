// Font/size scaling - all sizes scale relative to base 14px
export function fs(base: number, globalSize: number): string {
  return Math.round(base * (globalSize / 14)) + 'px';
}

// Same as fs but returns raw number (for Math.round etc.)
export function fsn(base: number, globalSize: number): number {
  return Math.round(base * (globalSize / 14));
}
