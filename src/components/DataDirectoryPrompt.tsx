/**
 * DataDirectoryPrompt — first-run setup screen for choosing where the app's
 * data (notes, canvases, PDF annotations, settings) is stored.
 *
 * "选择文件夹" lets the user pick a directory; the main process migrates the
 * default data over and relaunches (this renderer exits, so no onDone needed).
 * "使用默认位置" just marks the app as configured and calls onDone.
 */

import React from 'react';
import { askConfirm } from './ConfirmDialog';

const DataDirectoryPrompt: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const chooseFolder = async () => {
    if (!window.electronAPI) return;
    const dir = await window.electronAPI.pickDataDirectory();
    if (!dir) return;
    const res = await window.electronAPI.setDataDirectory(dir);
    if (!res.changed && res.error) {
      askConfirm({
        title: '更改数据目录失败',
        message: res.error,
        confirmLabel: '确定',
        danger: false,
        onConfirm: () => {},
      });
    }
  };

  const useDefault = async () => {
    if (window.electronAPI) await window.electronAPI.setDataDirectory(null);
    onDone();
  };

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 200,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 16, background: 'var(--page-bg)', color: 'var(--text-primary)',
    }}>
      <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.85">
        <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
      </svg>
      <div style={{ fontSize: '18px', fontWeight: 600 }}>选择数据存储位置</div>
      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', textAlign: 'center', lineHeight: 1.8, maxWidth: 460 }}>
        便笺、无限画布、PDF 批注和设置都会保存在你选择的文件夹中。<br />
        更改数据目录后应用会自动重启，旧数据会暂时保留，退出前可在设置中回退。
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
        <button onClick={chooseFolder} style={{
          padding: '10px 22px', borderRadius: '8px', background: 'var(--accent)', border: 'none',
          color: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
        }}>选择文件夹</button>
        <button onClick={useDefault} style={{
          padding: '10px 22px', borderRadius: '8px', background: 'var(--glass-bg-light)', border: '1px solid var(--glass-border)',
          color: 'var(--text-secondary)', fontSize: '13px', cursor: 'pointer', fontFamily: 'inherit',
        }}>使用默认位置</button>
      </div>
    </div>
  );
};

export default DataDirectoryPrompt;
