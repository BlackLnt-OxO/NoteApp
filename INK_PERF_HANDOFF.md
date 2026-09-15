# NoteApp 手写墨迹性能——交接文档

> 交给接手方（zcode）。请先读完本文 + 文末列出的源码文件，再动手。
> 仓库：`d:\ClaudeCode_Project\NoteApp`（git，分支 `main`）
> 当前 HEAD：`37c80de`。基线是 `0433afa`（v0.9.11），本次共 6 个提交。

---

## 1. 一句话现状

用户报的四类问题里，**打开密集画布慢**、**打开过大画布后小画布也慢**、**快捷粗细重启后还原** 已修复并有实测数据；
**跨 LOD 缩放卡几秒**和**拖动卡** 的原因已定位并修复（`37c80de`），但**用户还没在真机上复测**——这是当前唯一的开放项。

## 2. 验证状态（务必自己先跑一遍）

```
cd D:\ClaudeCode_Project\NoteApp
npm run dev          # 开发模式
npm test             # vitest，应为 320/320
npx tsc --noEmit     # 应为 0 错误
```

* `tsc` 0 错误；`vitest` 320/320（本次从 297 → 320，新增 23 个用例）；`vite build` 通过。
* **未验证**：真机上的跨 LOD 缩放与拖动（我这边量不到 Chromium 的真实帧耗时，见 §6）。
* **未打包、未升版本、未 tag、未 push**（按用户的既定要求，这些必须等他明确说）。

## 3. 用户报告的原始症状与结论

| 症状 | 根本原因 | 状态 |
|---|---|---|
| 打开密集画布要十几秒 | 每条 `renderVersion 2` 笔迹恢复时都新建一整套增量光栅（每 cell 两块 646KiB 的 CPU 画布 + 逐 cell 高斯模糊） | 已修 |
| 打开过大画布后，小画布也要十几秒 | 一个画布持有 ~1GiB tile + 268MiB 逐笔光栅 + 98MiB 增量缓存，离开文档时只丢引用等 GC；下一个画布分配时要先把它们逐块逐出 | 已修 |
| 拖动选中卡 + 十几秒才拖动 | 起拖与落笔各做一次**整页** tile 重建（3573 笔 × 2 次） | 已修 |
| 工具栏三个快捷粗细重启后还原 | `quickSizes` 只在内存 store 里，从未持久化 | 已修 |
| 显存打开画布暴涨 ~1.5GB | 固定 3× 超采样：tile 1536²=9MiB 一个，121 个 tile = 1089MiB | 已修（实测降到 ~50MiB） |
| 滚轮缩放卡 | ①材质化在 `[camera]` effect 里**同步**跑，滚轮每个事件都触发；②固定 3× 被 5.6× 下采样 | 已修 |
| **跨 LOD 边界卡几秒** | ①每帧预算是**字节制**，只约束内存不约束时间，密集 tile 一次烤完能占一秒；②LOD 升档**没有等画面停下**就立刻重烤全部可见 tile | 已修，**待复测** |
| **拖动仍然很卡** | 同 ①：平移进入未烤过的区域时，每个新 tile 整块烤 | 已修，**待复测**（另见 §7 待确认） |

## 4. 本次做了什么（按提交）

```
9fd4ec1  perf(ink): 打开/拖动密集画布不再卡十几秒
990d598  perf(ink): 按缩放自适应烘焙墨迹
18b1c75  fix(ink): 滚轮改用非 passive 监听
74f44fa  feat(diag): 墨迹缩放/平移性能单独成块
e070bf8  fix(diag): 帧采样改为挂在自己的渲染循环上
37c80de  perf(ink): tile 构建按时间切片 + LOD 升档等画面停下来再做
```

### 4.1 冷笔迹「一次成图」`renderStrokeOnce`（StreamingInkStroke.ts）
`renderVersion 2` 的 marker/fountain 笔迹不再走增量光栅，而是**一遍画完**：同一套采样/线宽数学，
按增量合成器**完全相同的顺序与次数**画 coverage → `source-in` 上色 → 单位变换下做模糊+alpha。
像素等价（40 条不同粗细/压力/羽化/快速甩笔的语料实测：单像素最大偏差 14/255，均值 0.003/255）。
铅笔（`style: 'pencil'`）仍走增量——它的颗粒只按步定义。

### 4.2 按显示密度自适应烘焙（InkTiles.ts + InkRasterCache.ts）
* `deviceScale = camera.zoom × devicePixelRatio`。**`uiScale` 不参与**（后备存储是 `layout×uiScale×dpr`，
  视口按视觉 px 量、又在 dpr 变换下绘制，两边抵消）。**这里写死了注释，别"修正"错。**
* `BAKE_STEPS = [0.25, 0.5, 1, 2, 3]`，取 **≥ deviceScale 的最小档** → 永远是下采样且 ≤2×。
  上限 3 是有意的：实时笔迹层（`StreamingInkStroke`）恒为 3×，这样"刚写的"和"已写的"没有锐度接缝。
* 迟滞：`BAKE_UP_RATIO=1.15`（升档）、`BAKE_DOWN_RATIO=2.4`（降档），避免停在档位边界反复重烤。
* **倍率记在 tile 上**（`registerTileScale`/`tileScaleOf`，WeakMap<canvas, number>），**不是记在这一层上**。
  原因：混合倍率是常态，而整笔擦的修复矩形是按倍率算像素偏移的——**倍率传错不是"变糊"而是"墨迹错位"**。
  所有写入方（盖章/自由擦/局部修复）都必须读所在 tile 自己的倍率。

### 4.3 懒索引 + 懒材质化（InkTiles.ts）
* 全篇**只索引**（包围盒+线段块，无像素），只在视口内（+1 tile margin）**光栅化**。
* 缺 tile 对绘制/局部修复/自由擦都是天然空操作。
* **不变量**：tile 的像素永远是「索引（矢量源）在某倍率下的函数」。
  因此任何 tile 都能随时丢弃重建，且重建结果与第一次**逐字节相同**——这条有测试锁定，是所有淘汰/重烤的安全依据。

### 4.4 时间切片 + 可续做的 tile 构建（**修「卡几秒」的关键**）
* 每帧预算改为**时间**（`MATERIALIZE_BUDGET_MS = 6`），不再是字节数或 tile 数。
* 单个 tile 的构建做成**可跨帧续做**（`TileBuild` 记录已烤到第几条笔画，按笔画切片，每 8 条查一次时钟）。
* 新 canvas **烤完才换上去**，旧 tile 在此之前照常渲染 → **永远不会露出烤了一半的 tile**。
* 构建状态存在 `buildStates: WeakMap<tilesMap, Map<tileKey, TileBuild>>`；倍率变了或 tile 移出视口就丢弃重来。

### 4.5 LOD 升档等画面停下（`rebake` / `CAMERA_SETTLE_MS`）
* 相机移动中：**只建"本来就不存在"的 tile**，已存在的先不动（略微变软，几乎看不出）。
* 相机静止 220ms 后（一次 setTimeout 回来重跑）才逐步重烤该升档的 tile；淘汰与光栅缓存清理同样只在静止时做。
* 淘汰：视口外 >3 tile 且该层超过 `TILE_BUDGET_BYTES=192MiB` 才回收最久未画的。

### 4.6 手势门控（正确性硬要求）
**擦除/拖选/落笔进行中，绝不重建或回收 tile。** 原因：整笔擦拖动期间被擦掉的笔迹仍在 `index.grid` 里
（只靠 `pendingIds` 抑制），自由橡皮的擦痕要到抬手才写进 store——此时重建会把**已擦掉的墨迹复活**。
同时：结构性重建（undo/redo/删/清）会换掉整个 tiles Map，而手势抓着旧 index/grid，所以重建时**直接清空进行中的手势**
（否则后续修复会写进已释放的画布，`width=0` 让修复静默变成空操作）。

### 4.7 拖动预览一次烘焙（InkDragPreview.ts，两视图共用）
起拖时把选中笔迹一次性烤进离屏画布（包围盒+羽化余量，按当前 deviceScale），之后每帧只 `drawImage`。
原来每帧重算：老笔迹重新平滑+重采样+填充（O(点数)）；v2 笔迹走实时缓存、大选区会把 96MiB 预算撑爆导致每帧重建刚淘汰的点列。
包围盒过大（>4M 像素）时回退逐笔绘制；拖动中缩放换了档位也回退。

### 4.8 其余
* 滚轮改**非 passive** 监听（React 把 `onWheel` 注册成 passive，`preventDefault()` 无效 →
  Ctrl+滚轮会缩放整个应用窗口）。两个视图都改，并移掉 JSX 上的 `onWheel` 避免双重处理。
* `drawVisibleTiles` 的 `imageSmoothingQuality` high→low（落到 ≤2× 后视觉无差别；**防接缝靠的是整数设备像素对齐，不是这个设置**）。
* 持久化拆分：正文（可能几 MB~几十 MB）与视图状态（相机+点阵）分成两个 key，
  否则平移一下 1 秒后就要重新序列化并写回 24MB。
* 快捷粗细持久化（新模块 inkToolPrefs.ts，两视图各一套 key）。
* 两个工具栏 + 画布文本/图片卡片改为**按字段订阅** store（原来订阅整个 store，任何相机/笔迹变化都重渲整个面板）。
* PDF 侧：`rebuildInk` 由「每次结构变化整页重新盖章」改为索引+懒材质化。**PDF 的烘焙倍率固定为 `PDF_BAKE_SCALE`**
  （页面面积有界，且页面背景按 3× 烘焙，ink 用更粗的密度会比页面文字软）。

## 5. 实测数据（用户真实文档：3573 笔 / 23.4 万点 / 24MB JSON）

| | 改前 | 改后 |
|---|---|---|
| 视口内 tile | 121 个 / **1089 MiB**（3×） | 50 个 / **50 MiB**（dpr1.25→1×）／12.5 MiB（dpr1→0.5×） |
| 打开耗时（懒建可见区） | 11.0 s 全量 | 1.9 s（分 5 帧，单帧有上界） |
| 每帧源像素读取 | 285M | **13.1M**（下采样 5.6× → 1.87×） |
| 峰值 RSS（软件 Skia 跑分） | 2.9 GB | 0.8 GB |

用户真机读数（诊断面板）：`缩放 1.26x · dpr 1.25 · 烘焙 2x · tile 121（屏上 9）· 113.9 MiB` —— 与设计一致。

## 6. 怎么复现这些测量（重要，别靠猜）

* **屏上读数**：`Ctrl+Shift+D` 打开诊断面板，**顶部第一块**就是「墨迹性能（无限画布 / PDF）」：
  缩放/烘焙倍率/tile 数/屏上数/MiB、**平移/缩放帧间隔**（p50/p95/worst/掉帧计数）、
  写字/其它重绘帧间隔、墨迹绘制耗时（上一帧/移动中最差/全局最差），最后一行直接给结论。
  * 采样挂在墨迹层自己的渲染循环上（`noteInkFrame`），**面板开不开都在采样**——面板是覆盖层，
    开着就没法滚动画布，所以必须"先操作、后看"。测一次手势：开面板→重置→关面板→操作→再开面板看。
* **批量跑分**（脚本跑真实数据，用于做改前改后对比）：
  1. localStorage 在 `DataLocation/Local Storage/leveldb/*.ldb`，是 leveldb 的 Table 格式且 block 用 snappy 压缩。
     我当时的做法：`npm i snappyjs --no-save` + 一个 ~80 行的 Table 解析脚本（读 footer 里的 index block、
     解压 data block、按 shared/non-shared 前缀还原 key/value），把 `stickynotes-inkcanvas-canvas*` 的正文导出成 JSON。
  2. 再写一个 scratch vitest 用例：`indexInkStrokes()` + 循环 `materializeTiles()` 到 `remaining===0`，
     打印 `tile 数 / inkTileBytes / 每帧源像素 / 耗时 / process.memoryUsage().rss`。
  3. **注意**：正文现在只有 `{ objects }`，相机在独立的 `-view` key 里（见 4.8 的持久化拆分）。
  4. 这些数据是用户的私人笔迹，**用完即删**，不要进仓库、不要提交。

## 7. 开放项 / 待确认（交给 zcode）

1. **跨 LOD 缩放与拖动的真机复测**（最高优先）。预期：跨档不再是「卡几秒」，而是「松开滚轮后画面逐步变清晰」。
   * 若 `平移/缩放帧间隔` 的 `worst` 仍有几百 ms，说明**别处还有整块工作**，需要用 §6 的方法定位。
2. **"拖动很卡"具体指哪条路径？** 用户的原话有歧义：可能指**平移画布**（走 tile 构建，已按 §4.4 处理），
   也可能指**拖选笔迹**（走 §4.7 的预览烘焙）。读数里的 `墨迹绘制` 能区分——请先问清再动手。
3. **自动保存仍是同步 localStorage**：正文真正变化时（停笔约 1 秒后）会序列化整篇并阻塞写入，
   密集文档约 100ms 级。彻底解决要换存储格式或走主进程 IPC，本次未做。
4. **铅笔笔迹的 tile 构建**仍走增量光栅（§4.1 的例外），会占用 96MiB 实时缓存并可能互相淘汰。
   用户那份画布没有铅笔笔迹，故未处理。
5. **LOD 上限 3×**：`deviceScale > 3` 时已提交墨迹与实时笔迹一起被上采样，不会更锐（两者一致，无接缝）。
   提高实时层倍率会让其实时缓存字节按倍率²增长，另作考虑。
6. **`ERASER_PERF_HANDOFF.md`（未跟踪）已过时**：它写「vitest 255/255」「结构操作整页重建 tile」，
   后者已被 §4.3 的懒材质化改变。要么更新它，要么删掉，避免误导。
7. **本文件（`INK_PERF_HANDOFF.md`）默认不提交**，与 `ERASER_PERF_HANDOFF.md` 一样留在工作区。

## 8. 工作约定（用户明确要求，务必遵守）

* **不要自动打包 / 升版本 / tag / push**，必须等用户明确说。
* 改完代码**直接 `git commit`**，不用问"要不要提交"；提交署名用仓库已配好的 `BlackLnt`。
* 不允许用 emoji 当图标（用 SVG 或文字）。
* 每次改完代码，在回复末尾附上启动命令，**分两行**（`cd` 一行、`npm run dev` 一行），不要带清端口那行。
* 用户的私人内容绝不进 git 仓库/提交元数据。
* 弹窗悬停要轻微高亮、按钮共用一套 hover 变量——是全局设计语言，新组件也要满足。

## 9. 关键文件

| 文件 | 作用 |
|---|---|
| `src/components/InfiniteInkCanvas/InkTiles.ts` | **核心**：烘焙档位/迟滞、逐 tile 倍率、懒索引、时间切片构建、淘汰。改了先读它的顶部注释 |
| `src/components/PdfAnnotation/InkRasterCache.ts` | 逐笔光栅缓存（LRU 256MiB）+ **`registerTileScale`/`tileScaleOf`** + `renderStrokeOnce` 的 scratch |
| `src/components/PdfAnnotation/StreamingInkStroke.ts` | 实时笔迹的增量 cell 光栅 + `renderStrokeOnce`（冷笔迹一次成图）。`samplePoint` 是两条路径共用的唯一采样真相 |
| `src/components/PdfAnnotation/InkTileErase.ts` | 局部区域修复（整笔擦用）。**修复矩形与光栅都必须用所在 tile 自己的倍率** |
| `src/components/PdfAnnotation/InkStrokeIndex.ts` | 世界坐标空间索引（全篇索引，与倍率无关，可跨倍率复用） |
| `src/components/InfiniteInkCanvas/InfiniteInkCanvas.tsx` | 画布：渲染循环、材质化链、手势门控、拖动预览 |
| `src/components/PdfAnnotation/PdfCanvas.tsx` | PDF：同构的第二份实现（局部 TILE/SCALE + 自己的 erase/drawVisible 副本） |
| `src/components/PdfAnnotation/InkDragPreview.ts` | 拖动预览一次烘焙（两视图共用） |
| `src/components/InkFrameStats.ts` | 性能读数单例：帧窗口、`noteInkFrame`、`cameraSettled` |
| `src/components/InkToolPrefs.ts`→`inkToolPrefs.ts` | 快捷粗细持久化 |
| `src/components/DiagnosticPanel.tsx` | 诊断面板（`Ctrl+Shift+D`），顶部是墨迹性能块 |
| `src/components/InfiniteInkCanvas/__tests__/InkTiles.lod.test.ts` | 锁 LOD/懒建/淘汰/时间切片不变量的 10 个用例 |

## 10. 测试里锁住的不变量（改代码时别破坏）

1. 一次成图的冷笔迹光栅与增量光栅一致（marker/fountain 有界偏差，铅笔逐字节相同）。
2. **非 3× 倍率下，整笔擦的局部修复结果 = 同倍率下整页重建**（抓"倍率传错导致墨迹错位"）。
3. **就地重烤后 = 按目标倍率新建**（逐字节）。
4. **淘汰后重建 = 首次构建**（逐字节）。
5. **被 `skipIds` 抑制的笔迹不会被复活**（抓"擦除中被重建"）。
6. **一次 pass 有界且可续做**：`budgetMs:0` 时 `materialized=0`、`remaining>0`，且 tiles 里不允许出现尺寸不对的半个 tile。
7. 滚轮：两个视图都**恰好注册一个** wheel 监听且 `passive:false`，一次事件只产生一次缩放。
8. 快捷粗细：往返持久化、损坏记录回退默认、两视图各一套 key。
9. 平移不重写正文（只写 `-view` key）。
