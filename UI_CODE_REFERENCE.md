# Sticky Notes — UI 代码参考

## 文件清单

```
src/
├── main.tsx                              # React 入口
├── App.tsx                               # 根组件（视图/侧边栏/弹窗/快捷键）
├── types.ts                              # Note、Tag、AppSettings 类型 + 默认值
├── utils.ts                              # fs/fSn 字体缩放工具函数
├── global.d.ts                           # Window.electronAPI 类型声明
├── store/index.ts                        # Zustand store (便笺 CRUD + 设置)
├── styles/global.css                     # 全局样式（暗色/亮色主题、组件 class）
└── components/
    ├── Sidebar.tsx                       # 左栏（新建便笺、标签列表、截图/长截图按钮）
    ├── NoteGrid.tsx                      # 网格视图（卡片排版、拖拽排序）
    ├── NoteCard.tsx                      # 便笺卡片（编辑、颜色、图片、resize、磁贴、灯箱）
    ├── CreateNoteDialog.tsx              # 新建便笺弹窗（内容、标签、颜色）
    ├── SettingsDialog.tsx                # 设置弹窗（主题、字体、背景、快捷键、颜色管理）
    ├── ColorPicker.tsx                   # UE5 风格取色器（色轮 + S/V 竖条 + RGB/HSV 滑条 + Hex 输入）
    ├── ScreenshotTool.tsx                # 截图结果处理（接收 IPC、Canvas 拼帧、创建便笺）
    ├── FirstScreenshotPrompt.tsx         # 首次截图引导提示
    └── DiagnosticPanel.tsx              # 长截图诊断面板（开发调试用）
```

---

## 1. App.tsx（根组件）

**职责**：窗口布局、新建/设置弹窗切换、主题/字体同步、Ctrl+滚轮缩放、标题栏

**布局结构**：
```
┌─ title-bar（38px, 拖拽区, 最小化/最大化/关闭按钮）─────────┐
│ ├─ Sidebar（220px 左栏）  │  NoteGrid（flex:1 内容区）     │
│                           │  └─ 设置齿轮按钮（右下角）      │
│ ├─ ScreenshotTool（隐藏 canvas + 拼接中 loading）          │
│ ├─ CreateNoteDialog（弹窗，条件渲染）                      │
│ ├─ SettingsDialog（弹窗，条件渲染）                        │
│ ├─ DiagnosticPanel（弹窗，Ctrl+Shift+D 切换）              │
│ └─ fontToast（Ctrl+滚轮缩放提示, 右下角）                  │
└────────────────────────────────────────────────────────────┘
```

**关键状态**：`showCreateDialog`, `showSettings`, `fontToast`, `isMaximized`

**特效**：
- 背景图片 + 透明度叠加 (`linear-gradient(rgba, rgba), url(bg)`)
- 设置齿轮 hover 旋转 30°
- 字体缩放 toast 带淡入淡出 + hover 停留

---

## 2. Sidebar.tsx（左栏）

**职责**：新建便笺按钮、标签分类列表、截图/长截图入口

**UI 元素**：
- `+ 新建便笺` 按钮（紫色 accent，全宽）
- `标签分类` 标题（大写，小字体）
- 标签列表（圆点颜色 + 名称 + 计数 badge）
  - 右键删除、点击重命名（inline input）
- `+ 添加标签`（虚线按钮 → 展开 input + 8 色圆点选择器 + 添加/取消）
- `截图` 按钮（底部，glass-btn 风格）
- `长截图` 按钮（底部，glass-btn 风格）

**交互**：点击标签切换 `activeTag` 过滤器；hover 显示编辑按钮 `...`

---

## 3. NoteGrid.tsx（网格视图）

**职责**：便笺卡片网格排列、拖拽排序、右键菜单、背景图片管理

**关键逻辑**：
- 自动布局算法：按可用宽度计算每行列数，垂直排列
- 选中便笺自动展开（`isExpanded = isSelected`），其他缩小
- 拖拽：`onPointerDown` → `setPointerCapture` → `onPointerMove`（更新位置）→ `onPointerUp`（持久化 `gridX/gridY`）
- 右键菜单：修改颜色、删除便笺、固定/取消固定
- 背景图片：上传后存到 `settings.backgroundImage`，带透明度滑块

**样式**：
- 选中卡片 `z-index: 10, scale(1.02)`
- 未选中卡片缩小（`w -= 30, h -= 24`）
- 默认卡片尺寸：260×200（`customSize: true` 时使用）

---

## 4. NoteCard.tsx（便笺卡片）

**职责**：便笺内容编辑、颜色管理、图片管理、resize、磁贴/灯箱

**UI 结构**：
```
┌─ 标题栏（拖拽 handle + 颜色圆点 + 磁贴按钮 + 删除按钮）────┐
│ ├─ 颜色圆点（hover 显示快速颜色 + 全部颜色下拉）            │
│ ├─ 磁贴按钮（双击左上角圆圈 / 点击按钮）                     │
│ └─ ✕ 删除按钮（hover 显示）                                 │
├─ contentEditable div（双击/选中展开时可编辑）               │
│   ├─ IME 组合输入支持（composing ref 防止重复触发）          │
│   └─ undo 栈（每次输入后 600ms debounce 保存快照）           │
├─ 图片区（绝对定位，可拖拽移动、四角 resize、悬停删除）       │
│   └─ 灯箱：点击图片 → 全屏 overlay + 滚轮缩放 + 拖拽平移    │
└─ resize-handle（右下角，drag 改变卡片宽高）                  │
```

**关键状态**：`content`, `isEditing`, `showMenu`, `lightboxImg`, `cardW/cardH`, `undoStack`

**特效**：
- 选中卡片展开动画（`scale(1.02)` + 宽度扩展）
- 颜色下拉菜单（`animate-scale-in`）
- 图片灯箱（`fadeIn 0.2s` + 滚轮缩放 + 拖拽平移）

---

## 5. CreateNoteDialog.tsx（新建便笺弹窗）

**UI 结构**：
```
┌─ 遮罩层（rgba(0,0,0,0.5) + blur(4px), 点击关闭）──────────┐
│ ┌─ dialog（glass 风格, minWidth:400, maxWidth:560）────┐  │
│ │ 标题：新建便笺                                        │  │
│ │ ┌─ textarea（autoFocus, 最小 90px 高, 可 resize）──┐ │  │
│ │ │  placeholder: "输入便笺内容..."                     │ │  │
│ │ └───────────────────────────────────────────────────┘ │  │
│ │ ┌─ 标签分类 ───────────────────────────────────────┐ │  │
│ │ │  [tag1] [tag2] [tag3] ...  (圆角按钮, 选中高亮)   │ │  │
│ │ └───────────────────────────────────────────────────┘ │  │
│ │ ┌─ 颜色 ──────────────────────────────────────────┐ │  │
│ │ │  ●●●●●  (12 色圆点, 选中白边框+阴影)              │ │  │
│ │ │  自定义颜色 [+] (hover 显示编辑/删除)              │ │  │
│ │ │  取色器按钮 (调出 ColorPicker)                     │ │  │
│ │ └───────────────────────────────────────────────────┘ │  │
│ │ ┌─ 图片上传（拖拽区域, 虚线边框）──────────────────┐ │  │
│ │ │ 📷 拖拽或点击上传图片                              │ │  │
│ │ └───────────────────────────────────────────────────┘ │  │
│ │ [取消] [确定]                                         │  │
│ └──────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

---

## 6. SettingsDialog.tsx（设置弹窗）

**UI 结构**：多个折叠分组
- **主题**：暗色/亮色 toggle
- **字体**：字体选择器 + 大小滑条 (11-28)
- **背景**：背景图片上传 + 透明度滑条 (0-100%)
- **网格**：网格间距滑条 (10-40)
- **快捷键**：截图/长截图/穿透/关闭全部/透明，可点击后按键录制
- **颜色**：12 色圆点 + 自定义颜色管理（增删改 + 取色器）
- **便笺样张**：实时预览卡片效果

---

## 7. ColorPicker.tsx（取色器）

**UE5 风格色轮取色器**

**UI 布局**：
```
┌─ 色轮（conic-gradient, 200×200, 圆形）───────────────────┐
│  └─ 中心白点（鼠标位置对应的色相+饱和度）                  │
├─ S/V 竖条（饱和度/明度渐变, 24×150）                       │
├─ RGB/HSB 滑条（R G B H S B 六条, 带数值显示）              │
├─ Hex 输入框 + 预览色块                                     │
├─ 吸管按钮（全屏截图取色）                                  │
└─ 旧/新颜色对比 + 确定/取消                                 │
```

**关键算法**（`ColorPicker.tsx:44-52`）：
- `conic-gradient(from 90deg, red, yellow, lime, cyan, blue, magenta, red)` 红色在右边顺时针
- 鼠标角度用 `atan2(dx, -dy)` 计算 CW from top
- `hue = (cssAngle - 90 + 360) % 360`

---

## 8. ScreenshotTool.tsx（截图结果处理）

**职责**：接收 `screenshot:completed` IPC → Canvas 拼帧 / 直接使用 → `addNote()` 创建便笺

**逻辑**：
- 如果 `isStitched && frames` → Canvas 逐帧 drawImage → toDataURL
- 如果 `dataUrl` 直接可用 → 直接使用
- 创建便笺：图片缩放至 50% 预览（`_previewH`），保留原图用于灯箱
- 显示 toast "截图已保存"

---

## 9. 全局样式体系（global.css）

**CSS 变量（暗色主题默认）**：
```css
--glass-bg: rgba(30, 30, 50, 0.65)      /* 毛玻璃背景 */
--glass-border: rgba(255, 255, 255, 0.12) /* 半透明边框 */
--accent: #6b5ce7                         /* 主色调（紫色） */
--text-primary: rgba(255,255,255,0.92)    /* 主文字 */
--radius-md: 12px                         /* 圆角 */
--transition: 0.2s cubic-bezier(0.4, 0, 0.2, 1)
```

**亮色主题**：`[data-theme="light"]` 覆盖为米白色系

**预定义 class**：
| class | 用途 |
|-------|------|
| `.glass` | 毛玻璃面板（bg+blur+border+shadow） |
| `.glass-panel` | 毛玻璃面板（无 shadow） |
| `.glass-btn` | 毛玻璃按钮 |
| `.glass-input` | 毛玻璃输入框（focus 紫色发光） |
| `.dialog-overlay` | 弹窗遮罩（50%黑+blur） |
| `.dialog` | 弹窗内容（glass+scaleIn 动画） |
| `.context-menu` | 右键菜单 |
| `.toggle` | 开关切换 |
| `.color-swatch` | 颜色圆点（hover 放大, selected 白边框） |
| `.title-bar` / `.title-btn` | 标题栏（拖拽区） |
| `.animate-fade-in` / `-scale-in` / `-slide-left` | 入场动画 |

---

## 10. utils.ts（工具函数）

```typescript
fs(base, globalFontSize)   // 基础字号 × 全局比例，返回 px 字符串
fsn(base, globalFontSize)  // 同上，返回 number
```

全局字体大小 11-28，所有 UI 尺寸通过 `fs()` 联动缩放。

---

## 11. types.ts（类型定义）

```typescript
Note { id, content, color, tag, images[], gridX, gridY, width, height, customSize, isFloating, ... }
Tag { id, name, color }
AppSettings { theme, fontFamily, fontSize, backgroundImage, backgroundOpacity, gridSize, defaultNoteColor, customNoteColors[], shortcutScreenshot, shortcutLongScreenshot, ... }
ImageAttachment { id, dataUrl, fileName, width, height, _previewH, _imgX, _imgY, ... }
```

---

## 12. Zustand Store（store/index.ts）

**核心 actions**：
- `addNote(note)` / `updateNote(id, partial)` / `deleteNote(id)` / `selectNote(id)`
- `addTag(tag)` / `updateTag(id, partial)` / `deleteTag(id)`
- `setActiveTag(id)` — 过滤便笺列表
- `updateSettings(partial)` — 更新设置
- `setNoteFloating(id, bool)` — 切换磁贴状态
- `loadData()` / `saveData()` — 通过 IPC 读写 `notes-data.json`

**compute 属性**：`filteredNotes`（按 activeTag + searchQuery 过滤）
