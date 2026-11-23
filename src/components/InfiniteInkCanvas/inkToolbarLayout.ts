import { useNoteStore } from '../../store';

export function useInkToolbarPosition() {
  return useNoteStore(state => state.settings.inkToolbarPosition);
}

export function saveInkToolbarPosition(position: import('../../inkToolbarPosition').InkToolbarPosition) {
  const store = useNoteStore.getState();
  store.updateSettings({ inkToolbarPosition: position });
}

export const INK_TOOLBAR_LAYOUT = 'ink:toolbar-layout';
