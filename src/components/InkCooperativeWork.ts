/** One deterministic implementation, consumed synchronously or across budgeted slices. */
export function finishInkWork<T>(work: Generator<void, T, unknown>): T {
  for (;;) { const step = work.next(); if (step.done) return step.value; }
}
let channel: MessageChannel | undefined;
const callbacks: (() => void)[] = [];
/** Yield to input without the nested setTimeout 4ms floor during large opens. */
export function postInkTask(callback: () => void): void {
  if (typeof MessageChannel === 'undefined') { setTimeout(callback, 0); return; }
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => callbacks.shift()?.();
    (channel.port1 as MessagePort & { unref?: () => void }).unref?.();
    (channel.port2 as MessagePort & { unref?: () => void }).unref?.();
  }
  callbacks.push(callback); channel.port2.postMessage(null);
}
