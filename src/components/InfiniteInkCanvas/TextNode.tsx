import React, { useRef, useEffect, useCallback, useState } from 'react';
import type { TextNodeData, Camera } from './types';
import { worldToScreen } from './constants';
import { useCanvasStore } from './useCanvasStore';
import { useNoteStore } from '../../store';

interface Props {
  node: TextNodeData;
  camera: Camera;
}

const TextNode: React.FC<Props> = ({ node, camera }) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { updateTextNode, deleteTextNode, setEditingTextId, pushHistory } = useCanvasStore();
  const uiScale = useNoteStore((s) => s.uiScale);
  const [content, setContent] = useState(node.content);

  // Convert world → screen position. The box keeps the node's (world) width so
  // re-editing a resized box wraps the same as its committed card. worldToScreen
  // returns VISUAL px; App is CSS-scaled by uiScale → divide geometry by uiScale.
  const screen = worldToScreen(node.x, node.y, camera);
  const screenX = screen.x / uiScale;
  const screenY = screen.y / uiScale;
  const screenW = Math.max(120, node.width * camera.zoom) / uiScale;
  const fontSizePx = Math.max(12, node.fontSize * camera.zoom) / uiScale;

  // Commit current content and close the editor. Even an EMPTY box is kept (it
  // becomes a visible placeholder card) so a tap/click that places a box never
  // makes it vanish — users can click the card again to type.
  const finishedRef = useRef(false);
  const commit = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    const el = containerRef.current;
    // offsetWidth/offsetHeight are LAYOUT px → visual px = ×uiScale → world = ÷zoom.
    const cssW = el?.offsetWidth ?? (node.width * camera.zoom) / uiScale;
    const cssH = el?.offsetHeight ?? 44;
    pushHistory();
    updateTextNode(node.id, {
      content,
      width: Math.max(60, (cssW * uiScale) / camera.zoom),
      height: Math.max(20, (cssH * uiScale) / camera.zoom),
    });
    setEditingTextId(null);
  }, [content, node.id, camera.zoom, uiScale, updateTextNode, pushHistory, setEditingTextId]);

  // Escape = explicit cancel: only deletes the node when it is still empty.
  const cancel = useCallback(() => {
    if (finishedRef.current) return;
    if (content.trim() === '') {
      finishedRef.current = true;
      deleteTextNode(node.id); // clears editingTextId itself
    } else {
      commit();
    }
  }, [content, commit, deleteTextNode]);

  // Auto-focus on mount + reset height to fit content.
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    }
  }, []);

  // Auto-grow textarea vertically (width stays fixed → wrap at box width).
  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setContent(val);
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    }
  }, []);

  // Blur = normal finish (keeps even an empty box).
  const handleBlur = useCallback(() => commit(), [commit]);

  // Keyboard shortcuts: Ctrl+Enter = finish; Escape = cancel (delete if empty).
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  }, [commit, cancel]);

  // Prevent pointer events from falling through
  const stopProp = (e: React.PointerEvent) => e.stopPropagation();
  const stopPropKey = (e: React.KeyboardEvent) => {
    // Allow Escape/Ctrl+Enter to bubble for our handler, block others
    if (!(e.key === 'Escape' || (e.key === 'Enter' && e.ctrlKey))) {
      e.stopPropagation();
    }
  };

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        left: screenX,
        top: screenY,
        width: screenW,
        boxSizing: 'border-box',
        zIndex: 10,
        pointerEvents: 'auto',
      }}
      onPointerDown={stopProp}
      onPointerMove={stopProp}
      onPointerUp={stopProp}
    >
      <textarea
        ref={textareaRef}
        value={content}
        onChange={handleInput}
        onBlur={handleBlur}
        onKeyDown={(e) => {
          handleKeyDown(e);
          stopPropKey(e);
        }}
        placeholder="输入文本..."
        style={{
          boxSizing: 'border-box',
          width: '100%',
          minWidth: 0,
          minHeight: '44px',
          maxWidth: 'none',
          padding: '10px 14px',
          background: 'var(--glass-bg, rgba(30,30,50,0.75))',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          border: '1px solid var(--glass-border-active, rgba(255,255,255,0.35))',
          borderRadius: '8px',
          color: 'var(--text-primary, #e0e0e0)',
          fontSize: fontSizePx + 'px',
          fontFamily: 'inherit',
          lineHeight: '1.5',
          resize: 'none',
          outline: 'none',
          overflow: 'hidden',
          boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
        }}
      />
    </div>
  );
};

export default TextNode;
