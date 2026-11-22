import { useEffect, useRef, type ReactNode } from 'react';

interface Props {
  label: string;
  tooltip?: string;
  children: ReactNode;
  onPress: () => void;
  onHold?: () => void;
  holdMs?: number;
  pressed?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  className?: string;
}

export default function InkToolButton({
  label, tooltip = label, children, onPress, onHold, holdMs = 350, pressed, expanded, disabled, className,
}: Props) {
  const pointer = useRef<{ id: number; x: number; y: number }>();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const ignoreClick = useRef(false);

  function stopTimer() {
    clearTimeout(timer.current);
    timer.current = undefined;
  }

  useEffect(() => () => clearTimeout(timer.current), []);

  return <button type="button" className={className ?? 'ink-toolbar-button'} disabled={disabled}
    aria-label={label} data-tooltip={onHold ? tooltip + '（长按设置）' : tooltip}
    aria-pressed={pressed} aria-haspopup={onHold ? 'dialog' : undefined} aria-expanded={expanded}
    onPointerDown={event => {
      if (event.button !== 0 || !onHold) return;
      stopTimer();
      pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      ignoreClick.current = false;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      timer.current = setTimeout(() => {
        timer.current = undefined;
        ignoreClick.current = true;
        onHold();
      }, holdMs);
    }}
    onPointerMove={event => {
      const start = pointer.current;
      if (!start || start.id !== event.pointerId) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12) {
        stopTimer();
        ignoreClick.current = true;
      }
    }}
    onPointerUp={event => {
      if (pointer.current?.id !== event.pointerId) return;
      stopTimer();
      pointer.current = undefined;
    }}
    onPointerCancel={() => { stopTimer(); pointer.current = undefined; ignoreClick.current = true; }}
    onLostPointerCapture={stopTimer}
    onClick={event => {
      if (!ignoreClick.current || event.detail === 0) onPress();
      ignoreClick.current = false;
    }}
    onContextMenu={onHold && (event => { event.preventDefault(); onHold(); })}
    onKeyDown={onHold && (event => {
      if (event.key === 'ArrowUp' && event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        onHold();
      }
    })}>
    {children}
  </button>;
}
