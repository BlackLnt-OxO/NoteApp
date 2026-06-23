# Sticky Notes - 现代便笺桌面应用

## 项目目标
构建一个 Electron 桌面便笺应用，支持网格视图、思维导图视图、截图（含长截图）、便笺磁贴、自定义颜色系统。追求美观现代 UE5 风格的 UI，同时保持低输入延迟。

## 技术栈
- **前端**: React 18 + TypeScript + Vite 5
- **桌面壳**: Electron 33 (frameless window, desktopCapturer)
- **状态管理**: Zustand
- **截图/图像**: Python 3.14 + OpenCV (cv2) — 长截图拼接、选区工具
- **辅助库**: Python mss (多屏截图库，已内嵌)
- **打包**: electron-builder (portable 模式)

## 目录结构
```
NoteApp/
├── src/                          # React 前端源码
│   ├── main.tsx                  # 入口
│   ├── App.tsx                   # 根组件，视图/侧边栏切换
│   ├── types.ts                  # Note、Tag、AppSettings 类型定义
│   ├── store/index.ts            # Zustand store (便笺 CRUD + 设置)
│   ├── utils.ts                  # fs/fSn 字体缩放工具函数
│   ├── global.d.ts               # electronAPI 类型声明
│   ├── styles/global.css         # 全局样式 + 自定义属性
│   └── components/
│       ├── Sidebar.tsx           # 左栏 (新建便笺、截图、设置入口)
│       ├── NoteGrid.tsx          # 网格视图 (卡片排版、拖拽)
│       ├── NoteCard.tsx          # 便笺卡片 (编辑、颜色、图片、resize)
│       ├── CreateNoteDialog.tsx  # 新建便笺弹窗 (内容、标签、颜色)
│       ├── SettingsDialog.tsx    # 设置弹窗 (主题、字体、快捷键、颜色)
│       ├── ColorPicker.tsx       # UE5 风格取色器 (色轮 + S/V条 + RGB/HSV)
│       ├── ScreenshotTool.tsx    # 截图工具 (普通 + 长截图)
│       ├── FirstScreenshotPrompt.tsx  # 首次截图引导
├── electron/                     # 主进程
│   ├── main.js                   # 主入口 (窗口管理、IPC、截图、吸管)
│   ├── preload.js                # contextBridge 暴露的 API
│   ├── floatingManager.js        # 便笺磁贴管理 (BrowserWindow 池)
│   ├── screenshot-overlay.html   # 截图选区覆盖层
│   ├── incrstitch.py             # 增量拼接 (长截图帧→累积图)
│   ├── stitch.py                 # 批量拼接 (所有帧一次性拼接)
│   ├── align.py                  # 帧对齐工具
│   ├── longshot/                 # Python 长截图工具集
│   │   ├── main.py               # 入口
│   │   ├── capture.py            # Win32 GDI 逐行捕获
│   │   ├── selector.py           # 选区工具
│   │   └── stitcher.py           # 拼接引擎
│   └── mss/                      # Python mss 库 (多屏截图，已内嵌)
├── dist/                         # Vite 输出 (前端构建产物)
├── dist-electron/                # electron-builder 输出 (打包后的 exe)
├── dist-electron-vXXX/           # 版本快照 (win-unpacked + builder-debug.yml)
├── package.json                  # 依赖 + electron-builder 配置
├── tsconfig.json
├── vite.config.ts
└── .gitignore                    # 排除 dist/、dist-electron*/、__pycache__/
```

## 已完成功能
- **网格视图**: 便笺卡片网格排列，拖拽排序，右键菜单（颜色、删除、固定）
- **思维导图视图**: 无限画布，自由拖拽便笺，滚轮缩放，自定义背景图
- **便笺磁贴**: 双击卡片左上角圆圈 → 生成置顶 frameless 透明窗口 → 可穿透/透明
- **普通截图**: desktopCapturer 选区捕获（与 Win+Shift+S 并存）
- **长截图**: 选区 → 逐帧捕获（200ms tick）→ incrstitch.py 增量拼接（模板匹配找重叠区）
- **UE5 风格取色器**: 色轮（conic-gradient）+ S/V 竖条 + RGB/HSV 滑条 + Hex 输入 + 吸管工具
- **自定义颜色系统**: 默认 12 色 + 用户可增删的自定义颜色，hover 显示编辑/删除按钮
- **设置面板**: 主题/字体/背景/网格/快捷键/颜色，字体大小和透明度实时生效
- **吸管取色**: 全屏 overlay + desktopCapturer 快照 → 鼠标移上去取像素颜色
- **键盘快捷键**: Ctrl+Shift+X 截图、Ctrl+P 磁贴穿透、Ctrl+Shift+W 关闭全部磁贴等

## Git 分支
- `master` — 主线，v255~v264
- `v247-longscreenshot` — 长截图测试分支（mss 捕获 + 诊断面板）

## 未完成任务 / 待改进
- **长截图 GPU 卡顿**: desktopCapturer 共享 GPU 管线，捕获时鼠标/滚轮会有卡顿感。曾尝试 mss (外部进程，async exec 失败)、GDI (capture.py) 但尚未完整体切换
- **长截图输出只有最后一帧**: 已通过 base64 增量拼接修复 (incrstitch.py)，大范围滚动时拼接可能失败
- **磁贴 resize 行为**: 首次 resize 跳变已修复（DOM 实际尺寸），但 frameless 窗口 resize 体验可优化
- **mss 进程稳定性**: async exec 无法找到 Python，execSync 同步阻塞，spawn 未充分测试
- **CI/自动构建**: 无
- **国际化**: 仅中文

## 重要设计决策
1. **版本管理**: v247 为验证版本，v255 起用 Git 管理源码，dist-electron-vXXX 只保留关键版本
2. **长截图拼接**: 选型经历了 批量拼接 → 增量拼接(base64) → mss → GDI，当前最稳定的是 base64 + incrstitch.py
3. **取色器坐标系**: CSS `conic-gradient(from 90deg)` 红在右边顺时针，鼠标角度用 `atan2(dx, -dy)` 计算 CW from top，`hue = (cssAngle - 90 + 360) % 360`
4. **自定义颜色同步**: 新建便笺弹窗和设置面板共用 `settings.customNoteColors`，通过 Zustand 全局状态同步
5. **便笺默认尺寸**: 260×200 (customSize: true 确保值生效，不被 CELL_W 覆盖)
6. **Python 内嵌**: mss 库完整复制到 electron/mss/，避免用户额外安装；长截图脚本通过 `execSync` 同步调用
7. **DPI 处理**: `saveBounds` 除以 scaleFactor 保存逻辑尺寸，加载时直接使用

## 常用开发命令
```bash
npm run dev          # 开发模式 (Vite + Electron 并行启动)
npm run build        # 生产构建 (Vite build → electron-builder)
```

构建后产物在 `dist-electron/`，创建版本快照：
```bash
mkdir -p dist-electron-vXXX
cp -r dist-electron/win-unpacked dist-electron-vXXX/
cp dist-electron/builder-debug.yml dist-electron-vXXX/
# 然后 git add -A && git commit && git tag vXXX
```

## 已知问题
- **长截图 GPU 卡顿** — 底层 desktopCapturer 限制，无完美解决方案
- **frameless 窗口 resize 边界手感** — Electron frameless + transparent 窗口 resize 区域受限
- **吸管在部分多屏环境可能取错色** — 依赖 desktopCapturer 的全屏截图
- **mss 工具链集成未完成** — Python 路径硬编码，缺少跨平台适配
- **ascii 打包下的 Python 脚本** — 需运行时 copyFileSync 到 temp 目录
