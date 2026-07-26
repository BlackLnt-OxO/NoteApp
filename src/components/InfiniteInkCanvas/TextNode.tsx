import React, { useRef, useEffect, useCallback, useState } from 'react';
import type { TextNodeData, Camera } from './types';
import { worldToScreen } from './constants';
import { useCanvasStore } from './useCanvasStore';

interface Props {
  node: TextNodeData;
  camera: Camera;
}

const TextNode: React.FC<Props> = ({ node, camera }) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { updateTextNode, deleteTextNode, setEditingTextId, pushHistory } =
    useCanvasStore();
  const [content, setContent] = useState(node.content);

  // Convert world → screen position
  const screen = worldToScreen(node.x, node.y, camera);

  // Auto-focus on mount
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    }
  }, []);

  // Auto-grow textarea
  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      setContent(val);
      const el = textareaRef.current;
      if (el) {
        el.style.height = 'auto';
        el.style.height = el.scrollHeight + 'px';
      }
    },
    [],
  );

  // Commit on blur
  const handleBlur = useCallback(() => {
    if (content.trim() === '') {
      // Delete empty text nodes
      deleteTextNode(node.id);
    } else {
      pushHistory();
      updateTextNode(node.id, {
        content,
        width: Math.max(100, containerRef.current?.offsetWidth ?? 100),
        height: Math.max(40, containerRef.current?.offsetHeight ?? 40),
      });
    }
    setEditingTextId(null);
  }, [content, node.id, updateTextNode, deleteTextNode, pushHistory, setEditingTextId]);

  // Keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        (e.target as HTMLTextAreaElement).blur();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (content.trim() === '') {
          deleteTextNode(node.id);
        } else {
          pushHistory();
          updateTextNode(node.id, {
            content,
            width: Math.max(100, containerRef.current?.offsetWidth ?? 100),
            height: Math.max(40, containerRef.current?.offsetHeight ?? 40),
          });
        }
        setEditingTextId(null);
      }
    },
    [content, node.id, updateTextNode, deleteTextNode, pushHistory, setEditingTextId],
  );

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
        left: screen.x,
        top: screen.y,
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
          minWidth: '120px',
          minHeight: '44px',
          maxWidth: '400px',
          padding: '10px 14px',
          background: 'var(--glass-bg, rgba(30,30,50,0.75))',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          border: '1px solid var(--glass-border-active, rgba(255,255,255,0.25))',
          borderRadius: '8px',
          color: 'var(--text-primary, #e0e0e0)',
          fontSize: node.fontSize * camera.zoom + 'px',
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
