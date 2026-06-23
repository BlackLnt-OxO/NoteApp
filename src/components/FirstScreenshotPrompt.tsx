import React from 'react';
import { useNoteStore } from '../store';

const FirstScreenshotPrompt: React.FC<{ onClose: (accepted: boolean) => void }> = ({ onClose }) => {
  const gfs = useNoteStore(s => s.settings.fontSize);

  return (
    <div className="dialog-overlay" onClick={() => onClose(false)}>
      <div className="dialog animate-scale-in" onClick={e => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <h3 style={{ fontSize: 16, marginBottom: 14 }}>截图时视频黑屏？</h3>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 12 }}>
          截图覆盖层可能导致 Chrome/Edge 浏览器中的视频（如直播）自动暂停或黑屏。
        </p>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 16 }}>
          是否自动为浏览器添加启动参数，防止截图时视频停止？
          <br /><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>（修改浏览器快捷方式，浏览器需重启生效，设置中可随时更改）</span>
        </p>
        <div className="dialog-actions">
          <button className="glass-btn" onClick={() => onClose(false)} style={{ fontSize: 13 }}>不了</button>
          <button onClick={() => onClose(true)} style={{
            padding: '9px 22px', background: 'var(--accent)', border: 'none',
            borderRadius: 8, color: '#fff', fontSize: 13, cursor: 'pointer',
          }}>是，帮我设置</button>
        </div>
      </div>
    </div>
  );
};

export default FirstScreenshotPrompt;
