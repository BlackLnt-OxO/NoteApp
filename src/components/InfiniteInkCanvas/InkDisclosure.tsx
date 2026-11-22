import { useLayoutEffect, useRef, type ReactNode } from 'react';

export default function InkDisclosure({ visible, children }: { visible: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.inert = !visible;
  }, [visible]);
  return <div ref={ref} className="ink-tool-disclosure" data-visible={visible} aria-hidden={!visible}>
    <div>{children}</div>
  </div>;
}
