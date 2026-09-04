# NoteApp（Sticky Notes）

现代便笺 + 无限手写画布 + PDF 标注 的 Electron 桌面应用。UI 走现代玻璃态（毛玻璃）视觉，同时保持低输入延迟，重点面向手写笔 / 数位板压感书写场景。

## 三大视图

应用内通过左侧栏在三种视图间切换（`ViewMode = 'notes' | 'inkcanvas' | 'pdf'`）：

| 视图 | 说明 |
| --- | --- |
| **便签**（notes） | 便笺卡片网格：创建 / 编辑 / 颜色 / 拖拽排序 / 置顶磁贴 / 截图。快捷入口大多源自早期版本，持续保留 |
| **无限画布**（inkcanvas） | 自由书写画布：瓦片化墨水层、缩放平移、选择 / 移动、文本卡片 / 图片对象 |
| **PDF 标注**（pdf） | 打开 PDF 直接在手写板上标注，标注以笔刷像素形式保存，重新打开可继续编辑 |

### 手写笔刷（PDF 标注与画布共用同一套引擎）

- **可变宽度连续笔画**：压力驱动的连续 ribbon 渲染（“逐段四边形 + 逐点圆帽”union、单次 `fill('nonzero')`），无空洞、无接缝；弧长重采样保证墨迹均匀
- **三种笔**：标记笔（marker，半透明层叠）、钢笔（fountain，出墨量随速度）、铅笔（pencil，细腻纹理）；另有激光笔（写时重亮、松笔淡出）
- **压感曲线**：压力 → 线宽采用 Photoshop 式 gamma 曲线，线宽下限可低至发丝级 ≈0.15px；默认平滑 5%，平滑上限 20%
- **压感透明度**：随压力变化，并钳制在“滑条不透明度 ±10 个百分点”
- **边缘羽化**：可选柔和软边；可选关闭
- **其他**：橡皮（圆圈光标）、文本卡片可编辑 / 拖动 / 右键删除、PDF 画布缩略图栏等

## 技术栈

- **桌面壳**: Electron 33（frameless 窗口）
- **前端**: React 18 + TypeScript + Vite 5
- **状态管理**: Zustand 4
- **PDF 渲染**: pdfjs-dist
- **坐标体系**: 全局 `uiScale` UI 缩放（整窗 `transform: scale`），画布 / PDF 坐标系随缩放保持一致
- **测试**: Vitest + Testing Library + jsdom

> 早期模块还包含 Python 截图 / 长截图工具链（`electron/mss/`、`electron/longshot/` 等），随版本迭代已不是主功能，但目录保留。

## 快速开始

```bash
npm install
npm run dev
```

`npm run dev` 会并行启动 Vite（`http://localhost:5173`）与 Electron。首次运行会在系统数据目录中写入一份 `sticky-notes-config.json` 指针文件，dev 模式下默认把用户数据落到项目根的 `DataLocation/`。

## 常用命令

```bash
npm run dev       # 开发模式（Vite + Electron）
npm test          # 运行全部单测（vitest run）
npx vitest run    # 同上
npx tsc --noEmit  # TypeScript 类型检查
npm run build     # 生产构建（vite build → electron-builder，portable exe 输出到 dist-electron/）
```

当前测试基线：**14 个测试文件 / 225 个用例全绿**，类型检查 0 错误。

## 目录结构

```
NoteApp/
├── electron/                        # Electron 主进程（Node）
│   ├── main.js                      # 入口：窗口、IPC、数据目录（可配置 userData）、托盘、重载迁移
│   ├── preload.js                   # contextBridge → window.electronAPI
│   ├── floatingManager.js           # 便签磁贴（置顶 / 透明 frameless 窗）
│   ├── diagnostic.js                # 诊断日志
│   └── …                            # 截图 / 长截图 Python 辅助（mss、longshot、stitch*.py 等）
├── src/                             # React 前端
│   ├── main.tsx                     # 入口
│   ├── App.tsx                      # 根组件（notes / inkcanvas / pdf 视图切换）
│   ├── types.ts                     # Note、Tag、AppSettings、ViewMode 等类型
│   ├── utils.ts / themeColors.ts    # fs/fSn 字体缩放工具、画布 / 笔刷主题色
│   ├── global.d.ts                  # electronAPI 类型声明
│   ├── store/index.ts               # Zustand 全局状态（便签 CRUD + 设置 + 数据目录）
│   ├── styles/global.css            # 全局样式 + 设计 tokens
│   └── components/
│       ├── Sidebar.tsx              # 左栏（视图切换、新建、设置入口）
│       ├── NoteGrid.tsx / NoteCard.tsx / FlowGrid.tsx …   # 便签视图
│       ├── CreateNoteDialog.tsx / SettingsDialog.tsx / ColorPicker.tsx / ConfirmDialog.tsx
│       ├── ScreenshotTool.tsx / DiagnosticPanel.tsx / DataDirectoryPrompt.tsx
│       ├── InfiniteInkCanvas/       # 无限手写画布
│       │   ├── InfiniteInkCanvas.tsx / CanvasView.tsx / CanvasRenderer.ts
│       │   ├── InkTiles.ts          # 瓦片墨水层（3× 超采样烘焙）+ 实时预览层
│       │   ├── StrokeEngine.ts      # 笔画引擎（压感曲线、平滑）
│       │   ├── TextNode.tsx / TextObject.tsx / ImageObject.tsx
│       │   ├── Toolbar.tsx / ToolbarShell.tsx / useToolbarStore.ts / useCanvasStore.ts
│       │   ├── constants.ts / types.ts / useCanvasLibrary.ts
│       │   └── __tests__/           # StrokeEngine / 坐标 / store 测试
│       └── PdfAnnotation/           # PDF 标注
│           ├── PdfEngine.ts         # 纯数学几何、1€ 滤波平滑、压力 / 坐标换算
│           ├── PdfBrushRenderers.ts # marker / fountain / pencil 渲染（几何 + 像素测试）
│           ├── PdfCanvas.tsx / PdfView.tsx / PdfStore.ts / PdfTypes.ts
│           ├── PdfLoader.ts / PdfLibrary.ts / PdfPicker.ts / PdfSidebar.tsx / PdfToolbar.tsx
│           └── __tests__/           # 引擎 / 笔刷 / loader / library / store 测试
├── DataLocation/                    # 运行时用户数据（dev：项目根）——已 gitignore，不入库
├── pdf-annotations/                 # PDF 标注数据（dev：项目根）——已 gitignore，不入库
├── package.json / package-lock.json
├── tsconfig.json / vite.config.ts / vitest.config.ts / .gitignore
```

## 数据与隐私

- 便笺正文、窗口状态、设置等以 JSON 存入**用户数据目录**（`userData`），可在设置中更改数据目录
- dev 模式下 `userData` 指向项目根的 `DataLocation/`，`pdf-annotations/` 存标注层数据 —— 两者均已被 `.gitignore` 排除，**不进入版本库**
- 打包后 `userData` 落到系统默认的 `appData/sticky-notes`，同样与仓库隔离
