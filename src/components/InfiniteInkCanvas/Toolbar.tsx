/**
 * Toolbar — the infinite canvas's binding of the shared `InkCore/InkToolbar`.
 *
 * The panel body lives in InkCore now (it was duplicated verbatim in
 * `PdfAnnotation/PdfToolbar.tsx`). All this adapter does is map this store's
 * field names onto the shared component's props, and supply the canvas-specific
 * clear wording. Mounted inside ToolbarShell.
 */

import React from 'react';
import { useCanvasStore } from './useCanvasStore';
import { askConfirm } from '../ConfirmDialog';
import InkToolbar from '../InkCore/InkToolbar';
import type { InkBrushType } from '../InkCore/inkTypes';

const Toolbar: React.FC = () => {
  // Subscribe field-by-field so a change to any unrelated slice of the store
  // doesn't re-render the whole panel.
  const activeTool = useCanvasStore((s) => s.activeTool);
  const brushType = useCanvasStore((s) => s.brush);
  const brush = useCanvasStore((s) => s.brushSettings);
  const showDotGrid = useCanvasStore((s) => s.showDotGrid);
  const selectionMode = useCanvasStore((s) => s.selectionMode);
  const eraserMode = useCanvasStore((s) => s.eraserMode);
  const insertMode = useCanvasStore((s) => s.insertMode);
  const history = useCanvasStore((s) => s.history);
  const redoStack = useCanvasStore((s) => s.redoStack);

  const setActiveTool = useCanvasStore((s) => s.setActiveTool);
  const setBrushType = useCanvasStore((s) => s.setBrush);
  const setBrush = useCanvasStore((s) => s.setBrushSettings);
  const setShowDotGrid = useCanvasStore((s) => s.setShowDotGrid);
  const setSelectionMode = useCanvasStore((s) => s.setSelectionMode);
  const setEraserMode = useCanvasStore((s) => s.setEraserMode);
  const setInsertMode = useCanvasStore((s) => s.setInsertMode);
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);

  return (
    <InkToolbar
      activeTool={activeTool}
      brushType={brushType as InkBrushType}
      brush={brush}
      showDotGrid={showDotGrid}
      selectionMode={selectionMode}
      eraserMode={eraserMode}
      insertMode={insertMode}
      canUndo={history.length > 0}
      canRedo={redoStack.length > 0}
      setActiveTool={setActiveTool}
      setBrushType={setBrushType}
      setBrush={setBrush}
      setShowDotGrid={setShowDotGrid}
      setSelectionMode={setSelectionMode}
      setEraserMode={setEraserMode}
      setInsertMode={setInsertMode}
      undo={undo}
      redo={redo}
      clearLabel="清空画布"
      onClear={() => askConfirm({
        title: '清空画布',
        message: '确定要清除画布上的所有内容吗？此操作可以撤销。',
        confirmLabel: '清空',
        danger: false,
        onConfirm: () => useCanvasStore.getState().clearCanvas(),
      })}
    />
  );
};

export default Toolbar;
