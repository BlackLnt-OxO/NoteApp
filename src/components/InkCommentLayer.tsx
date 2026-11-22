import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import {
  COMMENT_EDGES, COMMENT_HEADER_HEIGHT, COMMENT_TITLE, commentFromSelection, resizeComment,
  type CommentEdge, type CommentFrame, type CommentSelection,
} from './InkComments';
import { inkObjectVisible } from './InkViewportObjects';
import { isInkPointerActive, setPointerHold } from './inkInputActivity';
import type { PdfCamera, PdfItem } from './PdfAnnotation/PdfTypes';
import './inkComments.css';

interface Props {
  container: RefObject<HTMLDivElement>;
  items: readonly PdfItem[];
  selectedIds: readonly string[];
  camera: PdfCamera;
  uiScale: number;
  viewportWidth: number;
  viewportHeight: number;
  interactive: boolean;
  readSelection: () => CommentSelection | null;
  onCreate: (frame: CommentFrame) => void;
  onUpdate: (previous: CommentFrame, next: CommentFrame) => void;
  onSelect: (id: string) => void;
}

interface ResizeGesture {
  pointerId: number;
  target: HTMLElement;
  frame: CommentFrame;
  listeners: AbortController;
}

const textTargets = 'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]';
const modalTargets = '[data-file-dialog],.dialog-overlay,[data-lightbox],[aria-modal="true"]';

function CommentTitleInput({ title, finish }: { title: string; finish: (title: string | undefined, restoreFocus: boolean) => void }) {
  const finished = useRef(false);
  const close = (value: string | undefined, restoreFocus: boolean) => {
    if (finished.current) return;
    finished.current = true;
    finish(value, restoreFocus);
  };
  return <input
    className="ink-comment-title-input" aria-label="注释标题" autoFocus defaultValue={title}
    onFocus={event => event.currentTarget.select()}
    onBlur={event => close(event.currentTarget.value, false)}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(event.key === 'Enter' ? event.currentTarget.value : undefined, true);
      }
    }}
  />;
}

export default function InkCommentLayer({
  container, items, selectedIds, camera, uiScale, viewportWidth, viewportHeight, interactive,
  readSelection, onCreate, onUpdate, onSelect,
}: Props) {
  const frames = useMemo(() => items.filter((item): item is CommentFrame => item.type === 'comment'), [items]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CommentFrame | null>(null);
  const resize = useRef<ResizeGesture | null>(null);

  useEffect(() => {
    if (!interactive) return;
    const keyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key.toLowerCase() !== 'c' || event.ctrlKey || event.metaKey || event.altKey
        || event.shiftKey || event.repeat || event.isComposing || event.keyCode === 229 || isInkPointerActive()) return;
      if ((event.target instanceof Element && event.target.closest(textTargets))
        || document.activeElement?.closest(textTargets) || document.querySelector(modalTargets)) return;
      const selection = readSelection();
      if (!selection) return;
      const frame = commentFromSelection(selection, container.current);
      if (!frame) return;
      event.preventDefault();
      onCreate(frame);
      setEditingId(frame.id);
    };
    window.addEventListener('keydown', keyDown);
    return () => window.removeEventListener('keydown', keyDown);
  }, [interactive, container, onCreate, readSelection]);

  function releaseResize() {
    const gesture = resize.current;
    if (!gesture) return;
    resize.current = null;
    gesture.listeners.abort();
    setPointerHold(false);
    try {
      if (gesture.target.hasPointerCapture?.(gesture.pointerId)) gesture.target.releasePointerCapture(gesture.pointerId);
    } catch { /* The pointer has already been released. */ }
  }

  useEffect(() => {
    const cancel = () => {
      releaseResize();
      setDraft(null);
    };
    const flush = () => {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement && active.matches('.ink-comment-title-input')
        && container.current?.contains(active)) active.blur();
      cancel();
    };
    window.addEventListener('blur', cancel);
    window.addEventListener('ink:flush-gesture', flush);
    return () => {
      window.removeEventListener('blur', cancel);
      window.removeEventListener('ink:flush-gesture', flush);
      releaseResize();
    };
  }, [container]);

  useEffect(() => {
    if (resize.current && (!interactive || !frames.includes(resize.current.frame))) {
      releaseResize();
      setDraft(null);
    }
    if (editingId && (!interactive || !frames.some(frame => frame.id === editingId))) setEditingId(null);
  }, [interactive, frames, editingId]);

  function beginResize(event: ReactPointerEvent<HTMLSpanElement>, frame: CommentFrame, edge: CommentEdge) {
    if (!interactive || event.button !== 0 || isInkPointerActive()) return;
    const selection = readSelection();
    const origin = container.current?.getBoundingClientRect();
    if (!selection || !origin) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(frame.id);
    const target = event.currentTarget;
    const gesture: ResizeGesture = {
      pointerId: event.pointerId, target, frame, listeners: new AbortController(),
    };
    try { target.setPointerCapture?.(event.pointerId); } catch { /* Window listeners can still finish the gesture. */ }
    resize.current = gesture;
    setPointerHold(true);

    const startCamera = selection.camera;
    const startX = (event.clientX - origin.left - startCamera.x) / startCamera.zoom;
    const startY = (event.clientY - origin.top - startCamera.y) / startCamera.zoom;
    const nextFrame = (pointer: PointerEvent) => {
      const camera = readSelection()?.camera ?? startCamera;
      const bounds = container.current?.getBoundingClientRect() ?? origin;
      const dx = (pointer.clientX - bounds.left - camera.x) / camera.zoom - startX;
      const dy = (pointer.clientY - bounds.top - camera.y) / camera.zoom - startY;
      return resizeComment(frame, edge, dx, dy);
    };
    const finish = (pointer: PointerEvent) => {
      if (pointer.pointerId !== gesture.pointerId) return;
      if (pointer.type === 'lostpointercapture' && pointer.target !== target) return;
      const next = pointer.type === 'pointerup' ? nextFrame(pointer) : undefined;
      releaseResize();
      setDraft(null);
      if (next) onUpdate(frame, next);
    };
    // Window listeners keep the resize active when the pointer leaves the edge's hit area.
    const listening = { capture: true, signal: gesture.listeners.signal };
    window.addEventListener('pointermove', pointer => {
      if (pointer.pointerId === gesture.pointerId) setDraft(nextFrame(pointer));
    }, listening);
    window.addEventListener('pointerup', finish, listening);
    window.addEventListener('pointercancel', finish, listening);
    window.addEventListener('lostpointercapture', finish, listening);
  }

  const scale = camera.zoom / uiScale;
  return <>{frames.map((frame) => {
    const selected = selectedIds.includes(frame.id);
    const editing = interactive && editingId === frame.id && selected;
    if (!selected && !inkObjectVisible(frame, camera, viewportWidth, viewportHeight, [])) return null;
    const box = draft?.id === frame.id ? draft : frame;
    const style = {
      left: (box.x * camera.zoom + camera.x) / uiScale,
      top: (box.y * camera.zoom + camera.y) / uiScale,
      width: box.width * scale,
      height: box.height * scale,
      fontSize: 14 * scale,
      '--comment-header-height': `${COMMENT_HEADER_HEIGHT * scale}px`,
      '--comment-handle-size': `${7 / uiScale}px`,
    } as CSSProperties;
    const editTitle = () => {
      if (!interactive) return;
      onSelect(frame.id);
      setEditingId(frame.id);
    };
    return <Fragment key={frame.id}>
      <div aria-hidden="true" className="ink-comment-fill" data-ink-comment-fill={frame.id} data-selected={selected} style={style} />
      <div className="ink-comment-controls" data-ink-object-id={frame.id} style={style}>
        <div
          className="ink-comment-title" data-ink-comment-title={frame.id} data-interactive={interactive}
          role={interactive && !editing ? 'button' : undefined} tabIndex={interactive && selected && !editing ? 0 : undefined}
          onDoubleClick={editTitle}
          onKeyDown={event => {
            if (event.target !== event.currentTarget || event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); editTitle(); }
          }}
        >
          {editing ? <CommentTitleInput title={frame.title} finish={(title, restoreFocus) => {
            setEditingId(null);
            if (title !== undefined) onUpdate(frame, { ...frame, title: title.trim() || COMMENT_TITLE });
            if (restoreFocus) container.current?.focus({ preventScroll: true });
          }} /> : <span className="ink-comment-label">{frame.title}</span>}
        </div>
        {interactive && selected && !editing && COMMENT_EDGES.map(edge => <span key={edge}
          aria-hidden="true" className="ink-comment-resize" data-ink-comment-resize={edge}
          onPointerDown={event => beginResize(event, frame, edge)}
        />)}
      </div>
    </Fragment>;
  })}</>;
}
