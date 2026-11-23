import type { ImageObject as ImageObj, Camera } from './types';
import { useCanvasStore } from './useCanvasStore';
import InkImageFrame from '../InkImageFrame';

export default function ImageObject({ obj, camera }: { obj: ImageObj; camera: Camera }) {
  const selected = useCanvasStore(state => state.selectedIds.includes(obj.id));
  const interactive = useCanvasStore(state => state.activeTool === 'select');
  return <InkImageFrame object={obj} camera={camera} selected={selected} interactive={interactive} layer={1}
    onMove={(dx, dy) => useCanvasStore.getState().commitSelectionMove([obj.id], dx, dy)}
    onRemove={() => useCanvasStore.getState().deleteObject(obj.id)}
    onResize={(width, height) => {
      const store = useCanvasStore.getState();
      store.pushHistory();
      store.updateImageObject(obj.id, { width, height });
    }} />;
}
