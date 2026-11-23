export function startNoteMeasure() {
  return typeof document !== 'undefined' && document.documentElement.hasAttribute('data-note-motion-metrics')
    ? performance.now() : undefined;
}

export function finishNoteMeasure(name: string, start?: number) {
  if (start !== undefined) performance.measure(`noteapp:${name}`, { start, end: performance.now() });
}
