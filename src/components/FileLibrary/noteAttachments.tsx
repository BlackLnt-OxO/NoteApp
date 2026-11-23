import type { NoteAttachment } from '../../types';
import { useNoteStore } from '../../store';
import { showLocalAssetPreview } from './assetLibrary';
import { droppedNoteImage, type DroppedItem, useLocalFileOffline } from './externalFiles';
import { fileKind, fileName, fileTypeLabel } from './fileTypes';
import IconAction from '../IconAction';

export function noteDropContents(items: DroppedItem[]) {
  return {
    images: items.flatMap(item => {
      const image = droppedNoteImage(item);
      return image ? [image] : [];
    }),
    attachments: items.flatMap(item => item.image ? [] : [{ id: crypto.randomUUID(), path: item.path }]),
  };
}

export function appendNoteDrop(noteId: string, items: DroppedItem[], textBottom = 0) {
  const store = useNoteStore.getState();
  const note = store.notes.find(item => item.id === noteId);
  if (!note || !items.length) return;
  const { images, attachments } = noteDropContents(items);
  const estimatedTextEnd = Math.ceil(14 + note.content.split('\n').length * store.settings.fontSize * 1.5);
  let bottom = note.images.reduce((end, image, index) => {
    const height = image._previewH ?? 100;
    return Math.max(end, (image._imgY ?? 10 + index * (height + 8)) + height + 8);
  }, Math.max(textBottom, estimatedTextEnd) + 8);
  const placedImages = images.map(image => {
    const next = { ...image, _imgY: bottom };
    bottom += 108;
    return next;
  });
  store.updateNote(noteId, {
    ...(images.length ? { images: [...note.images, ...placedImages] } : {}),
    ...(attachments.length ? { attachments: [...(note.attachments ?? []), ...attachments] } : {}),
  });
}

export function openNoteAttachment(noteId: string, attachmentId: string) {
  const attachment = useNoteStore.getState().notes.find(note => note.id === noteId)?.attachments?.find(item => item.id === attachmentId);
  if (!attachment) return;
  showLocalAssetPreview(attachment.path, (previous, path) => {
    const store = useNoteStore.getState();
    const attachments = store.notes.find(note => note.id === noteId)?.attachments;
    if (!attachments?.some(item => item.id === attachmentId && item.path === previous)) return false;
    store.updateNote(noteId, { attachments: attachments.map(item => item.id === attachmentId ? { ...item, path } : item) });
    return true;
  });
}

function AttachmentRow({ item, onOpen, onRemove }: {
  item: NoteAttachment; onOpen?: () => void; onRemove?: () => void;
}) {
  const offline = useLocalFileOffline(item.path);
  return <div className="note-attachment" data-offline={offline || undefined}>
    {onOpen
      ? <button type="button" className="note-attachment-open" onClick={onOpen} data-tooltip={item.path}>{fileName(item.path)}</button>
      : <span>{fileName(item.path)}</span>}
    <small>{offline ? '文件离线' : fileTypeLabel(fileKind(item.path))}</small>
    {onRemove && <IconAction danger label="移除附件" onClick={onRemove} />}
  </div>;
}

export function NoteAttachments({ items, onOpen, onRemove }: {
  items: NoteAttachment[]; onOpen?: (id: string) => void; onRemove?: (id: string) => void;
}) {
  if (!items.length) return null;
  return <div className="note-attachments">{items.map(item => <AttachmentRow key={item.id} item={item}
    onOpen={onOpen && (() => onOpen(item.id))} onRemove={onRemove && (() => onRemove(item.id))} />)}</div>;
}
