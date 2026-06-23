import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNoteStore } from '../store';
import { fs, fsn } from '../utils';
import type { DiagConfig, DiagStatus, PreviewUpdate, CaptureProgress, EventLoopStats } from '../types';

interface DiagnosticPanelProps {
  onClose: () => void;
  visible: boolean;
}

interface DiagStats {
  captureStats: { count: number; avg: number; p95: number; max: number } | null;
  stitchStats: { count: number; avg: number; p95: number; max: number } | null;
  previewStats: { count: number; avg: number; p95: number; max: number } | null;
  eventLoopMain: { p95Ms: number; maxMs: number; over50ms: number } | null;
  ipcLargeCount: number;
  previewFullResize: boolean;
  lastUpdate: number;
}

const MODE_LABELS: Record<string, string> = {
  'baseline': 'A. 完整基准',
  'capture-only': 'B. 仅截图',
  'stitch-only': 'C. 仅拼接',
  'overlay-only': 'D. 仅遮罩层',
  'capture-no-overlay': 'E. 截图无遮罩',
  'capture-save-tiles-no-stitch': 'F. 截图存文件',
  'baseline-with-preview': 'G. 基准+预览',
  'baseline-no-preview': 'H. 基准-无预览',
  'preview-only': 'I. 仅预览',
};

const INTERVAL_OPTIONS = [100, 300, 500, 1000];
const AREA_OPTIONS = [
  { value: 'current-selection', label: '当前选区' },
  { value: 'fullscreen', label: '全屏' },
  { value: '1280x720', label: '1280×720' },
  { value: '1920x1080', label: '1920×1080' },
];
const PREVIEW_WIDTHS = [180, 220, 240];
const PREVIEW_FPS = [2, 4];

const DiagnosticPanel: React.FC<DiagnosticPanelProps> = ({ onClose, visible }) => {
  const settings = useNoteStore(s => s.settings);
  const gfs = settings.fontSize;

  const [config, setConfig] = useState<DiagConfig>({
    mode: 'baseline',
    captureInterval: 300,
    captureArea: 'current-selection',
    previewEnabled: false,
    previewWidth: 220,
    previewMaxFps: 4,
    previewMaxHeightMode: 'selection-height',
    previewFixedMaxHeight: 600,
  });
  const [active, setActive] = useState(false);
  const [stats, setStats] = useState<DiagStats>({
    captureStats: null,
    stitchStats: null,
    previewStats: null,
    eventLoopMain: null,
    ipcLargeCount: 0,
    previewFullResize: false,
    lastUpdate: 0,
  });
  const [logPath, setLogPath] = useState<string | null>(null);
  const [modes, setModes] = useState<string[]>([]);
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rendererLoopRef = useRef<{ stop: () => any } | null>(null);
  const rafMonitorRef = useRef<{ stop: () => any } | null>(null);
  const [rendererLoopStats, setRendererLoopStats] = useState<{ p95Ms: number; maxMs: number; over50ms: number } | null>(null);
  const [rafStats, setRafStats] = useState<{ maxFrameMs: number; over33: number; over50: number; over100: number } | null>(null);
  const [mouseDelay, setMouseDelay] = useState<{ p95Ms: number; maxMs: number } | null>(null);

  // Load modes list
  useEffect(() => {
    window.electronAPI?.diagGetModes().then(setModes).catch(() => {});
  }, []);

  // Load initial config
  useEffect(() => {
    window.electronAPI?.diagGetConfig().then(c => {
      if (c) setConfig(c);
    }).catch(() => {});
  }, []);

  // Listen for diagnostic status updates
  useEffect(() => {
    if (!window.electronAPI) return;

    window.electronAPI.onDiagStatus((data: DiagStatus) => {
      setActive(data.active);
      if (data.logPath) setLogPath(data.logPath);
      if (!data.active) {
        // Capture stopped, fetch final stats
        window.electronAPI?.diagGetStats().then(s => {
          if (s) updateStatsFromLoop(s);
        }).catch(() => {});
        if (statsIntervalRef.current) {
          clearInterval(statsIntervalRef.current);
          statsIntervalRef.current = null;
        }
      }
    });

    window.electronAPI.onDiagStats((data: EventLoopStats) => {
      if (data.scope === 'main') {
        setStats(s => ({
          ...s,
          eventLoopMain: {
            p95Ms: data.p95Ms,
            maxMs: data.maxMs,
            over50ms: data.over50ms,
          },
        }));
      }
    });

    window.electronAPI.onPreviewUpdate((data: PreviewUpdate) => {
      setStats(s => ({
        ...s,
        lastUpdate: Date.now(),
        previewFullResize: !data.incremental,
      }));
    });
  }, []);

  // Poll stats during active capture
  useEffect(() => {
    if (active) {
      statsIntervalRef.current = setInterval(() => {
        window.electronAPI?.diagGetStats().then(s => {
          if (s) updateStatsFromLoop(s);
        }).catch(() => {});
      }, 1000);
    }
    return () => {
      if (statsIntervalRef.current) {
        clearInterval(statsIntervalRef.current);
        statsIntervalRef.current = null;
      }
    };
  }, [active]);

  // Renderer event loop lag monitor (runs during active capture)
  useEffect(() => {
    if (!active) {
      if (rendererLoopRef.current) {
        const s = rendererLoopRef.current.stop();
        setRendererLoopStats(s);
        rendererLoopRef.current = null;
      }
      return;
    }

    const samples: number[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = true;
    let lastTime = performance.now();

    function tick() {
      if (!running) return;
      const now = performance.now();
      const lag = Math.max(0, now - lastTime - 100);
      samples.push(lag);
      lastTime = now;
      timer = setTimeout(tick, 100);
    }

    timer = setTimeout(tick, 100);

    rendererLoopRef.current = {
      stop: () => {
        running = false;
        if (timer) clearTimeout(timer);
        const sorted = [...samples].sort((a, b) => a - b);
        return {
          p95Ms: sorted.length > 0 ? Math.round(sorted[Math.floor(sorted.length * 0.95)] * 100) / 100 : 0,
          maxMs: sorted.length > 0 ? Math.round(sorted[sorted.length - 1] * 100) / 100 : 0,
          over50ms: samples.filter(l => l > 50).length,
        };
      },
    };

    return () => {
      if (rendererLoopRef.current) {
        rendererLoopRef.current.stop();
        rendererLoopRef.current = null;
      }
    };
  }, [active]);

  // RAF frame interval monitor
  useEffect(() => {
    if (!active) {
      if (rafMonitorRef.current) {
        const s = rafMonitorRef.current.stop();
        setRafStats(s);
        rafMonitorRef.current = null;
      }
      return;
    }

    const frameIntervals: number[] = [];
    let lastFrameTime = performance.now();
    let rafId: number;
    let running = true;

    function frame() {
      if (!running) return;
      const now = performance.now();
      const interval = now - lastFrameTime;
      frameIntervals.push(interval);
      lastFrameTime = now;
      rafId = requestAnimationFrame(frame);
    }

    rafId = requestAnimationFrame(frame);

    rafMonitorRef.current = {
      stop: () => {
        running = false;
        cancelAnimationFrame(rafId);
        return {
          maxFrameMs: frameIntervals.length > 0 ? Math.round(Math.max(...frameIntervals) * 100) / 100 : 0,
          over33: frameIntervals.filter(f => f > 33).length,
          over50: frameIntervals.filter(f => f > 50).length,
          over100: frameIntervals.filter(f => f > 100).length,
        };
      },
    };

    return () => {
      if (rafMonitorRef.current) {
        rafMonitorRef.current.stop();
        rafMonitorRef.current = null;
      };
    };
  }, [active]);

  // Mouse input delay monitor (sampled, low overhead)
  useEffect(() => {
    if (!active) return;

    const delays: number[] = [];
    const onMove = (e: PointerEvent) => {
      const eventTime = e.timeStamp;
      const now = performance.now();
      // timeStamp is in ms since time origin, same as performance.now()
      // Delay = now - eventTimestamp (processing lag)
      const delay = Math.max(0, now - eventTime);
      delays.push(delay);
      // Keep last 200 samples
      if (delays.length > 200) delays.splice(0, delays.length - 200);
    };

    window.addEventListener('pointermove', onMove, { passive: true });

    // Aggregate every 2 seconds
    const aggTimer = setInterval(() => {
      if (delays.length === 0) return;
      const sorted = [...delays].sort((a, b) => a - b);
      setMouseDelay({
        p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 100) / 100,
        maxMs: Math.round(sorted[sorted.length - 1] * 100) / 100,
      });
    }, 2000);

    return () => {
      window.removeEventListener('pointermove', onMove);
      clearInterval(aggTimer);
      setMouseDelay(null);
    };
  }, [active]);

  function updateStatsFromLoop(s: any) {
    setStats(prev => ({
      ...prev,
      captureStats: s.captureStats || prev.captureStats,
      stitchStats: s.stitchStats || prev.stitchStats,
      previewStats: s.previewStats || prev.previewStats,
      lastUpdate: Date.now(),
    }));
  }

  async function applyConfig(partial: Partial<DiagConfig>) {
    const newConfig = { ...config, ...partial };
    setConfig(newConfig);
    await window.electronAPI?.diagSetConfig(newConfig);
  }

  async function handleStartStop() {
    if (active) {
      // Stop
      await window.electronAPI?.cancelScreenshot();
      setActive(false);
    } else {
      // Start: apply current config, then trigger long screenshot
      await window.electronAPI?.diagSetConfig(config);
      await window.electronAPI?.startLongScreenshot();
      setActive(true);
    }
  }

  if (!visible) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 10001,
    }} onClick={onClose}>
      <div className="glass-panel" onClick={e => e.stopPropagation()} style={{
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid var(--glass-border)',
        borderRadius: 'var(--radius-xl)',
        padding: fsn(16, gfs),
        maxWidth: fsn(520, gfs),
        width: '90vw',
        maxHeight: '85vh',
        overflow: 'auto',
        color: 'var(--text-primary)',
        fontSize: fs(13, gfs),
        boxShadow: 'var(--glass-shadow)',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginBottom: fsn(12, gfs), paddingBottom: fsn(8, gfs),
          borderBottom: '1px solid var(--glass-border)',
        }}>
          <span style={{ fontWeight: 600, fontSize: fs(15, gfs) }}>
            🔬 长截图诊断面板
          </span>
          <button className="glass-btn" onClick={onClose}
            style={{ fontSize: fs(13, gfs), padding: `${fs(4, gfs)} ${fs(10, gfs)}` }}>
            ✕
          </button>
        </div>

        <div style={{ display: 'flex', gap: fsn(12, gfs), flexDirection: 'column' }}>
          {/* Mode selector */}
          <div>
            <label style={{ display: 'block', fontSize: fs(11, gfs), color: 'var(--text-secondary)', marginBottom: fs(4, gfs) }}>
              诊断模式
            </label>
            <select
              value={config.mode}
              onChange={e => applyConfig({ mode: e.target.value })}
              disabled={active}
              style={{
                width: '100%', padding: `${fs(6, gfs)} ${fs(8, gfs)}`,
                fontSize: fs(12, gfs), borderRadius: '8px',
                background: 'var(--glass-bg-light)', border: '1px solid var(--glass-border)',
                color: 'var(--text-primary)',
                fontFamily: 'inherit',
              }}>
              {(modes.length > 0 ? modes : Object.keys(MODE_LABELS)).map(m => (
                <option key={m} value={m}>{MODE_LABELS[m] || m}</option>
              ))}
            </select>
          </div>

          {/* Capture interval */}
          <div>
            <label style={{ display: 'block', fontSize: fs(11, gfs), color: 'var(--text-secondary)', marginBottom: fs(4, gfs) }}>
              截图间隔
            </label>
            <div style={{ display: 'flex', gap: fsn(6, gfs) }}>
              {INTERVAL_OPTIONS.map(iv => (
                <button key={iv} className="glass-btn"
                  disabled={active}
                  onClick={() => applyConfig({ captureInterval: iv })}
                  style={{
                    flex: 1, padding: `${fs(5, gfs)} ${fs(8, gfs)}`,
                    fontSize: fs(11, gfs),
                    background: config.captureInterval === iv ? 'var(--accent)' : 'var(--glass-bg-light)',
                    color: config.captureInterval === iv ? '#fff' : 'var(--text-primary)',
                  }}>
                  {iv}ms
                </button>
              ))}
            </div>
          </div>

          {/* Capture area */}
          <div>
            <label style={{ display: 'block', fontSize: fs(11, gfs), color: 'var(--text-secondary)', marginBottom: fs(4, gfs) }}>
              截图区域
            </label>
            <select
              value={config.captureArea}
              onChange={e => applyConfig({ captureArea: e.target.value })}
              disabled={active}
              style={{
                width: '100%', padding: `${fs(6, gfs)} ${fs(8, gfs)}`,
                fontSize: fs(12, gfs), borderRadius: '8px',
                background: 'var(--glass-bg-light)', border: '1px solid var(--glass-border)',
                color: 'var(--text-primary)',
                fontFamily: 'inherit',
              }}>
              {AREA_OPTIONS.map(a => (
                <option key={a.value} value={a.value}>{a.label}</option>
              ))}
            </select>
          </div>

          {/* Preview toggle & params */}
          <div>
            <label style={{ display: 'flex', alignItems: 'center', gap: fsn(8, gfs), fontSize: fs(11, gfs), color: 'var(--text-secondary)', marginBottom: fs(4, gfs), cursor: 'pointer' }}>
              <input type="checkbox"
                checked={config.previewEnabled}
                disabled={active}
                onChange={e => applyConfig({ previewEnabled: e.target.checked })}
              />
              启用实时缩略图预览
            </label>
            {config.previewEnabled && (
              <div style={{ marginLeft: fsn(24, gfs), display: 'flex', flexDirection: 'column', gap: fsn(4, gfs), marginTop: fs(4, gfs) }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: fsn(8, gfs) }}>
                  <span style={{ fontSize: fs(10, gfs), color: 'var(--text-secondary)', minWidth: fsn(40, gfs) }}>预览宽:</span>
                  {PREVIEW_WIDTHS.map(pw => (
                    <button key={pw} className="glass-btn"
                      disabled={active}
                      onClick={() => applyConfig({ previewWidth: pw })}
                      style={{
                        padding: `${fs(3, gfs)} ${fs(6, gfs)}`, fontSize: fs(10, gfs),
                        background: config.previewWidth === pw ? 'var(--accent)' : 'var(--glass-bg-light)',
                        color: config.previewWidth === pw ? '#fff' : 'var(--text-primary)',
                      }}>
                      {pw}px
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: fsn(8, gfs) }}>
                  <span style={{ fontSize: fs(10, gfs), color: 'var(--text-secondary)', minWidth: fsn(40, gfs) }}>更新率:</span>
                  {PREVIEW_FPS.map(fps => (
                    <button key={fps} className="glass-btn"
                      disabled={active}
                      onClick={() => applyConfig({ previewMaxFps: fps })}
                      style={{
                        padding: `${fs(3, gfs)} ${fs(6, gfs)}`, fontSize: fs(10, gfs),
                        background: config.previewMaxFps === fps ? 'var(--accent)' : 'var(--glass-bg-light)',
                        color: config.previewMaxFps === fps ? '#fff' : 'var(--text-primary)',
                      }}>
                      {fps}fps
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Start/Stop button */}
          <div style={{ display: 'flex', gap: fsn(8, gfs), marginTop: fsn(4, gfs) }}>
            <button className="glass-btn"
              onClick={handleStartStop}
              style={{
                flex: 1, padding: `${fs(8, gfs)} ${fs(16, gfs)}`,
                fontSize: fs(14, gfs), fontWeight: 600,
                background: active ? 'rgba(230,80,80,0.85)' : 'rgba(0,180,100,0.85)',
                color: '#fff', border: 'none',
              }}>
              {active ? '⏹ 停止测试' : '▶ 开始测试'}
            </button>
          </div>

          {/* Real-time stats */}
          <div style={{
            background: 'rgba(0,0,0,0.3)',
            borderRadius: '10px',
            padding: fsn(10, gfs),
            fontSize: fs(11, gfs),
            fontFamily: 'monospace',
            color: '#8f8',
            maxHeight: fsn(200, gfs),
            overflow: 'auto',
          }}>
            <div style={{ fontSize: fs(10, gfs), color: 'var(--text-secondary)', marginBottom: fs(4, gfs) }}>
              {active ? '🟢 运行中' : '⚪ 就绪'} | 模式: {MODE_LABELS[config.mode] || config.mode}
            </div>

            {stats.captureStats && stats.captureStats.count > 0 && (
              <div style={{ marginTop: fs(4, gfs) }}>
                📷 Capture: {stats.captureStats.count}次 |
                avg={stats.captureStats.avg}ms |
                p95={stats.captureStats.p95}ms |
                max={stats.captureStats.max}ms
              </div>
            )}

            {stats.stitchStats && stats.stitchStats.count > 0 && (
              <div>
                🧩 Stitch: {stats.stitchStats.count}次 |
                avg={stats.stitchStats.avg}ms |
                p95={stats.stitchStats.p95}ms |
                max={stats.stitchStats.max}ms
              </div>
            )}

            {stats.previewStats && stats.previewStats.count > 0 && (
              <div>
                🖼️ Preview: {stats.previewStats.count}次 |
                avg={stats.previewStats.avg}ms |
                p95={stats.previewStats.p95}ms |
                max={stats.previewStats.max}ms
                {stats.previewFullResize && <span style={{ color: '#f88' }}> ⚠️FULL_RESIZE</span>}
              </div>
            )}

            {stats.eventLoopMain && (
              <div>
                🔄 Main Event Loop: p95={stats.eventLoopMain.p95Ms}ms |
                max={stats.eventLoopMain.maxMs}ms |
                &gt;50ms={stats.eventLoopMain.over50ms}次
              </div>
            )}

            {rendererLoopStats && (
              <div>
                🖥️ Renderer Event Loop: p95={rendererLoopStats.p95Ms}ms |
                max={rendererLoopStats.maxMs}ms |
                &gt;50ms={rendererLoopStats.over50ms}次
              </div>
            )}

            {rafStats && (
              <div>
                🎬 RAF Frames: max={rafStats.maxFrameMs}ms |
                &gt;33ms={rafStats.over33}次 |
                &gt;50ms={rafStats.over50}次 |
                &gt;100ms={rafStats.over100}次
              </div>
            )}

            {mouseDelay && (
              <div>
                🖱️ Mouse Input Delay: p95={mouseDelay.p95Ms}ms |
                max={mouseDelay.maxMs}ms
              </div>
            )}

            {stats.ipcLargeCount > 0 && (
              <div style={{ color: '#f88' }}>
                ⚠️ IPC Large Payload: {stats.ipcLargeCount}次
              </div>
            )}

            {logPath && (
              <div style={{ fontSize: fs(9, gfs), color: 'var(--text-secondary)', marginTop: fs(4, gfs), wordBreak: 'break-all' }}>
                📄 {logPath}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default DiagnosticPanel;
