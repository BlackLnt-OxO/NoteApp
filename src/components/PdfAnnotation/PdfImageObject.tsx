import type { PdfImageObject as PdfImgObj, PdfCamera } from './PdfTypes';
import { usePdfStore } from './PdfStore';
import InkImageFrame from '../InkImageFrame';

export default function PdfImageObject({ obj, page, camera, interactive }: {
  obj: PdfImgObj; page: number; camera: PdfCamera; interactive: boolean;
}) {
  const selected = usePdfStore(state => state.selectedIds.includes(obj.id));
  return <InkImageFrame key={page} object={obj} camera={camera} selected={selected} interactive={interactive} layer={5}
    onRemove={() => usePdfStore.getState().deleteObject(page, obj.id)}
    onResize={(width, height) => {
      const store = usePdfStore.getState();
      store.pushHistory(page);
      store.updateImageObject(page, obj.id, { width, height });
    }} />;
}
