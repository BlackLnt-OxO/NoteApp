import { useShallow } from 'zustand/react/shallow';
import { askConfirm } from '../ConfirmDialog';
import { useCanvasStore } from './useCanvasStore';
import { useCanvasToolbarStore } from './useToolbarStore';
import ToolbarShell from './ToolbarShell';

export default function Toolbar() {
  const controls = useCanvasStore(useShallow(state => ({
    tool: state.activeTool,
    brush: state.brush,
    settings: state.brushSettings,
    setTool: state.setActiveTool,
    setBrush: state.setBrush,
    update: state.setBrushSettings,
    selectionMode: state.selectionMode,
    setSelectionMode: state.setSelectionMode,
    eraserMode: state.eraserMode,
    setEraserMode: state.setEraserMode,
    insertMode: state.insertMode,
    setInsertMode: state.setInsertMode,
    showDotGrid: state.showDotGrid,
    setShowDotGrid: state.setShowDotGrid,
    canUndo: state.history.length > 0,
    canRedo: state.redoStack.length > 0,
    undo: state.undo,
    redo: state.redo,
  })));
  const preferences = useCanvasToolbarStore();
  return <ToolbarShell controls={{ ...controls, ...preferences, clearLabel: '清空画布',
    clear: () => askConfirm({
      title: '清空画布', message: '确定要清除画布上的所有内容吗？此操作可以撤销。',
      confirmLabel: '清空', danger: false, onConfirm: () => useCanvasStore.getState().clearCanvas(),
    }),
  }} />;
}
