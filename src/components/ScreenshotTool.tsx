import React, { useEffect, useRef, useState } from 'react';
import { useNoteStore } from '../store';

interface ScreenshotResult {
  dataUrl?: string;
  width?: number;
  height?: number;
  isStitched?: boolean;
  frames?: { dataUrl: string; width: number; height: number }[];
  totalWidth?: number;
  totalHeight?: number;
}

const ScreenshotTool: React.FC = () => {
  const addNote = useNoteStore(s => s.addNote);
  const tags = useNoteStore(s => s.tags);
  const [isStitching, setIsStitching] = useState(false);
  const stitchingCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!window.electronAPI) return;

    const unsubscribe = window.electronAPI.onScreenshotCompleted(async (result: ScreenshotResult) => {
      if (!result) return;

      let finalDataUrl: string | null = null;
      let finalWidth = result.width || 800;
      let finalHeight = result.height || 600;

      if (result.isStitched && result.frames && result.frames.length > 1) {
        setIsStitching(true);
        await new Promise(resolve => setTimeout(resolve, 100));

        const canvas = stitchingCanvasRef.current;
        if (canvas) {
          const totalHeight = result.totalHeight || result.frames.reduce((s, f) => s + f.height, 0);
          const maxWidth = result.totalWidth || Math.max(...result.frames.map(f => f.width));

          canvas.width = maxWidth;
          canvas.height = totalHeight;
          const ctx = canvas.getContext('2d');

          if (ctx) {
            let yOffset = 0;
            for (const frame of result.frames) {
              const img = new Image();
              img.src = frame.dataUrl;
              await new Promise<void>((resolve) => {
                img.onload = () => {
                  ctx.drawImage(img, 0, yOffset, maxWidth, img.height);
                  yOffset += img.height;
                  resolve();
                };
                img.onerror = () => resolve();
              });
            }

            finalDataUrl = canvas.toDataURL('image/png');
            finalWidth = maxWidth;
            finalHeight = totalHeight;
          }
        }
        setIsStitching(false);
      } else if (result.dataUrl) {
        finalDataUrl = result.dataUrl;
        finalWidth = result.width || 800;
        finalHeight = result.height || 600;
      }

      if (finalDataUrl) {
        const state = useNoteStore.getState();
        const defaultColor = state.settings.defaultNoteColor;
        const tagId = state.tags.find(t => t.name === '截图' || t.id === 'screenshot')?.id || 'screenshot';

        // Display at 50% in note, but keep original for lightbox
        const previewH = Math.round(Math.min(finalHeight * 0.5, 360));
        const aspect = finalWidth / Math.max(finalHeight, 1);
        const noteW = Math.round(previewH * aspect) + 32;
        const noteH = previewH + 72;

        addNote({
          content: `截图 ${new Date().toLocaleString('zh-CN')}`,
          color: defaultColor,
          tag: tagId,
          images: [{
            id: 'ss_' + Date.now(),
            dataUrl: finalDataUrl,
            fileName: `screenshot_${Date.now()}.png`,
            width: finalWidth,
            height: finalHeight,
            _previewH: previewH,
          }],
          gridX: Math.floor(Math.random() * 200),
          gridY: Math.floor(Math.random() * 200),
          width: noteW,
          height: noteH,
          customSize: true,
        });

        window.electronAPI?.showToast('截图已保存');
      }
    });

    return () => { unsubscribe?.(); };
  }, []);

  return (
    <>
      <canvas ref={stitchingCanvasRef} style={{ display: 'none' }} />
      {isStitching && (
        <div style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000,
        }}>
          <div className="glass-panel" style={{
            padding: '20px 28px', textAlign: 'center', borderRadius: 'var(--radius-xl)',
          }}>
            <div style={{ color: 'var(--text-primary)', fontSize: '14px' }}>正在拼接长截图...</div>
          </div>
        </div>
      )}
    </>
  );
};

export default ScreenshotTool;
