import type { ButtonHTMLAttributes } from 'react';

export function ActionIcon({ icon = 'close', pressed = false }: { icon?: 'close' | 'pin'; pressed?: boolean }) {
  return <svg aria-hidden="true" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor"
    strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round">
    {icon === 'close' ? <path d="m4 4 8 8m0-8-8 8" /> : <>
      <path d="m6 2 6 3-2 1-.8 3L10 11 4 8l2 .1 1.5-3L6 2Z" fill={pressed ? 'currentColor' : 'none'} />
      <path d="m6.7 9.4-2.2 4" />
    </>}
  </svg>;
}

export default function IconAction({ icon = 'close', danger, label, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>
  & { icon?: 'close' | 'pin'; danger?: boolean; label: string }) {
  return <button type="button" aria-label={label} data-tooltip={label} data-action={danger ? 'delete' : icon}
    {...props} className={`icon-action ${className}`}>
    <ActionIcon icon={icon} pressed={props['aria-pressed'] === true} />
  </button>;
}
