import { useShallow } from 'zustand/react/shallow';
import { askConfirm } from '../ConfirmDialog';
import { usePdfToolbarStore } from '../InfiniteInkCanvas/useToolbarStore';
import ToolbarShell from '../InfiniteInkCanvas/ToolbarShell';
import { usePdfStore } from './PdfStore';

export default function PdfToolbar() {
  const controls = usePdfStore(useShallow(state => ({
    tool: state.activeTool,
    brush: state.brushType,
    settings: state.brush,
    setTool: state.setActiveTool,
    setBrush: state.setBrushType,
    update: state.setBrush,
    selectionMode: state.selectionMode,
    setSelectionMode: state.setSelectionMode,
    eraserMode: state.eraserMode,
    setEraserMode: state.setEraserMode,
    insertMode: state.insertMode,
    setInsertMode: state.setInsertMode,
    showDotGrid: state.showDotGrid,
    setShowDotGrid: state.setShowDotGrid,
    canUndo: (state.history[state.currentPage]?.length ?? 0) > 0,
    canRedo: (state.redoStack[state.currentPage]?.length ?? 0) > 0,
    undo: state.undo,
    redo: state.redo,
  })));
  const preferences = usePdfToolbarStore();
  return <ToolbarShell controls={{ ...controls, ...preferences, clearLabel: '清空本页',
    clear: () => askConfirm({
      title: '清空本页', message: '确定要清除本页的所有批注吗？可以撤销。',
      confirmLabel: '清空', danger: false, onConfirm: () => usePdfStore.getState().clearPage(),
    }),
  }} />;
}
