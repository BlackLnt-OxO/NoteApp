import { useNoteStore } from '../store';

const modes = [['notes', '便笺'], ['inkcanvas', '画布'], ['pdf', '文件']] as const;

export default function WorkspaceModeSwitch() {
  const viewMode = useNoteStore(state => state.viewMode);
  const setViewMode = useNoteStore(state => state.setViewMode);

  return <nav aria-label="工作区" className="workspace-mode-switch">
    {modes.map(([mode, label]) => (
      <button key={mode} type="button" className="glass-btn" aria-current={viewMode === mode ? 'page' : undefined}
        onClick={() => setViewMode(mode)}>
        {label}
      </button>
    ))}
  </nav>;
}
