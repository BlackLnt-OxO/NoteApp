/**
 * PdfTextNode — in-place editor for a newly inserted / re-opened PDF text card.
 * Mirrors InfiniteInkCanvas/TextNode: auto-focus textarea, Ctrl+Enter / blur
 * commits (keeping even an empty box as a visible placeholder card), Escape
 * cancels (deletes the box if it is still empty). The card stays light with the
 * fixed PDF_ANNOTATION_BLUE text (node colors) — not theme glass, because a PDF
 * page is always light.
 */
import React, { useRef, useEffect, useCallback, useState } from 'react';
import type { PdfTextObject, PdfCamera } from './PdfTypes';
import { worldToScreen } from '../InkCore/inkGeometry';
import { usePdfStore } from './PdfStore';
import { useNoteStore } from '../../store';

interface Props {
  node: PdfTextObject;
  page: number;
  camera: PdfCamera;
}

const PdfTextNode: React.FC<Props> = ({ node, page, camera }) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const uiScale = useNoteStore((s) => s.uiScale);
  const updateTextNode = usePdfStore((s) => s.updateTextNode);
  const deleteTextNode = usePdfStore((s) => s.deleteTextNode);
  const setEditingTextId = usePdfStore((s) => s.setEditingTextId);
  const pushHistory = usePdfStore((s) => s.pushHistory);
  const [content, setContent] = useState(node.content);

  // After the editor closes, restore the tool saved when it was opened (a freshly
  // placed node → back to 'pen' with its brush subtype; a re-opened card → the tool
  // the user was using). Consumed once so later clicks never spawn another box.
  const finishReturn = useCallback(() => {
    const st = usePdfStore.getState();
    const tool = st.textCommitReturnTool;
    st.setTextCommitReturnTool(null);
    if (tool) st.setActiveTool(tool);
  }, []);

  // worldToScreen returns VISUAL px; App is CSS-scaled by uiScale → /uiScale.
  const screen = worldToScreen(node.x, node.y, camera);
  const screenX = screen.x / uiScale;
  const screenY = screen.y / uiScale;
  const screenW = Math.max(120, node.width * camera.zoom) / uiScale;
  const fontSizePx = Math.max(12, node.fontSize * camera.zoom) / uiScale;

  const finishedRef = useRef(false);
  const commit = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    const el = containerRef.current;
    // offsetWidth/offsetHeight are LAYOUT px → visual px = ×uiScale → world = ÷zoom.
    const cssW = el?.offsetWidth ?? (node.width * camera.zoom) / uiScale;
    const cssH = el?.offsetHeight ?? 44;
    pushHistory(page);
    updateTextNode(page, node.id, {
      content,
      width: Math.max(60, (cssW * uiScale) / camera.zoom),
      height: Math.max(20, (cssH * uiScale) / camera.zoom),
    });
    setEditingTextId(null);
    finishReturn();
  }, [content, node.id, page, camera.zoom, uiScale, updateTextNode, pushHistory, setEditingTextId, finishReturn]);

  // Escape = explicit cancel: only deletes the node when it is still empty.
  const cancel = useCallback(() => {
    if (finishedRef.current) return;
    if (content.trim() === '') {
      finishedRef.current = true;
      deleteTextNode(page, node.id); // clears editingTextId itself
      finishReturn();
    } else {
      commit();
    }
  }, [content, commit, deleteTextNode, page, node.id, finishReturn]);

  // Auto-focus on mount + reset height to fit content.
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    }
  }, []);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setContent(val);
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    }
  }, []);

  const handleBlur = useCallback(() => commit(), [commit]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  }, [commit, cancel]);

  const stopProp = (e: React.PointerEvent) => e.stopPropagation();
  const stopPropKey = (e: React.KeyboardEvent) => {
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
          background: node.backgroundColor,
          border: '1px solid rgba(37,99,235,0.6)',
          borderRadius: '8px',
          color: node.color,
          fontSize: fontSizePx + 'px',
          fontFamily: 'inherit',
          lineHeight: '1.5',
          resize: 'none',
          outline: 'none',
          overflow: 'hidden',
          boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
        }}
      />
    </div>
  );
};

export default PdfTextNode;
