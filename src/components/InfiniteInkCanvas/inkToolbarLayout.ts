import { useNoteStore } from '../../store';

export function useInkToolbarDock() {
  return useNoteStore(state => state.settings.inkToolbarDock === 'top' ? 'top' : 'bottom');
}

export const INK_TOOLBAR_LAYOUT = 'ink:toolbar-layout';
