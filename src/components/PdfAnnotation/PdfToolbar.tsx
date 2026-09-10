/**
 * PdfToolbar — the PDF view's binding of the shared `InkCore/InkToolbar`.
 *
 * The panel body lives in InkCore now (it was duplicated verbatim from
 * `InfiniteInkCanvas/Toolbar.tsx`). All this adapter does is map this store's
 * field names onto the shared component's props — note the store renames this
 * side has always had: `brushType` is the selected brush and `brush` is its
 * settings — and supply the page-scoped clear wording. Mounted inside
 * ToolbarShell.
 */

import React from 'react';
import { usePdfStore } from './PdfStore';
import InkToolbar from '../InkCore/InkToolbar';

const PdfToolbar: React.FC = () => {
  // Subscribe field-by-field so a change to any unrelated slice of the store
  // doesn't re-render the whole panel.
  const activeTool = usePdfStore((s) => s.activeTool);
  const brushType = usePdfStore((s) => s.brushType);
  const brush = usePdfStore((s) => s.brush);
  const showDotGrid = usePdfStore((s) => s.showDotGrid);
  const selectionMode = usePdfStore((s) => s.selectionMode);
  const eraserMode = usePdfStore((s) => s.eraserMode);
  const insertMode = usePdfStore((s) => s.insertMode);
  const currentPage = usePdfStore((s) => s.currentPage);
  const history = usePdfStore((s) => s.history);
  const redoStack = usePdfStore((s) => s.redoStack);

  const setActiveTool = usePdfStore((s) => s.setActiveTool);
  const setBrushType = usePdfStore((s) => s.setBrushType);
  const setBrush = usePdfStore((s) => s.setBrush);
  const setShowDotGrid = usePdfStore((s) => s.setShowDotGrid);
  const setSelectionMode = usePdfStore((s) => s.setSelectionMode);
  const setEraserMode = usePdfStore((s) => s.setEraserMode);
  const setInsertMode = usePdfStore((s) => s.setInsertMode);
  const undo = usePdfStore((s) => s.undo);
  const redo = usePdfStore((s) => s.redo);
  const clearPage = usePdfStore((s) => s.clearPage);

  // History is per page, so undo/redo availability is too.
  const canUndo = (history[currentPage]?.length ?? 0) > 0;
  const canRedo = (redoStack[currentPage]?.length ?? 0) > 0;

  return (
    <InkToolbar
      activeTool={activeTool}
      brushType={brushType}
      brush={brush}
      showDotGrid={showDotGrid}
      selectionMode={selectionMode}
      eraserMode={eraserMode}
      insertMode={insertMode}
      canUndo={canUndo}
      canRedo={canRedo}
      setActiveTool={setActiveTool}
      setBrushType={setBrushType}
      setBrush={setBrush}
      setShowDotGrid={setShowDotGrid}
      setSelectionMode={setSelectionMode}
      setEraserMode={setEraserMode}
      setInsertMode={setInsertMode}
      undo={undo}
      redo={redo}
      clearLabel="清空本页"
      onClear={clearPage}
    />
  );
};

export default PdfToolbar;
