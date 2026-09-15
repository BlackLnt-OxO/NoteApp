# 「擦除笔画」滑动擦除——高笔画密度下卡顿 修复交接

> 交接文档。动手前请读完本文 + 文末列出的源码文件。
> 仓库：`d:\ClaudeCode_Project\NoteApp`（git，分支 `main`），当前 HEAD：`37c80de`。
> 基线（本文档最初撰写时）：`79dbf7e`，vitest 255/255。
>
> **本文档已于 `37c80de` 之后重新对齐实现**。原始版本写于固定 3× 烘焙、整页重建 tile 的时代，
> 其中「tile 固定 3× 超采样」「结构操作整页重建 tile」「每次删除清整 tile 再重画该 tile 内所有笔画」
> 「一次手势开始时预哈希 grid」**四处已与代码不符**，下面按当前实现改正，并在相关处标注了改动。
> 墨迹层本身（LOD / 懒材质化 / 时间切片 / 拖动预览）另有专文：**`INK_PERF_HANDOFF.md`，先读那篇**。

---

## 1. 一句话需求

「橡皮 → 擦除笔画」模式下按住滑动：橡皮圈碰到哪条墨笔就整条删除，**拖动必须跟手不卡**——
尤其当画面某个局部笔画密度非常高时（几十上百条叠在一个屏幕区域内）也不能掉帧。画布与 PDF 两个视图行为一致。

## 2. 数据 / 渲染模型（决定改法，务必先懂）

- 笔迹 = 矢量对象 `Stroke`/`PdfStroke`：`points[]`（世界坐标）、`size`、`color`、
  `compositeOperation: 'source-over' | 'destination-out'`。
  - `destination-out` 的"笔"是**自由橡皮**产生的**擦痕对象**（擦一笔存一条），不是墨。
  - 同一扁平数组顺序即 z 序：墨笔画在前、擦痕在后；擦痕会"刻掉"其之下所有已画像素。
- 已提交的墨笔画被**栅格化进离屏 tile**（`TILE = 512` 世界单位一个）。矢量是源、tile 是派生。
  - **【已改】烘焙倍率不再是固定 3×**，而是按显示密度自适应、逐个 tile 记录，混合倍率是常态——
    见 §3.7。这直接决定整笔擦的修复该怎么做，是本文档最要紧的一条。
- **【已改】tile 是懒建的**：只有"被看到"的区域才栅格化，视口外可以根本没有 canvas。
  缺 tile 对绘制 / 局部修复 / 自由擦**都是天然空操作**（不是 bug）。全篇只在索引里有矢量，没有像素。
- 主画布每帧 = drawImage(背景) + 画可见 tile + 画"正在画"的那条。
- **【已改】** undo/redo/删/清 等结构操作仍通过 store 的 `renderEpoch++` 触发，
  但处理方式不再是"整页重建 tile"，而是：丢弃旧图层 → **全篇重新索引（无像素）** → 按视口懒材质化。
  见 §3.8。
- 历史用数组引用共享，一次手势一个快照 = 一次撤销。

两个视图是**同一套引擎、两套镜像代码**，改任何逻辑两边都要改：
- 画布（无页码）：`src/components/InfiniteInkCanvas/InfiniteInkCanvas.tsx` + `src/components/InfiniteInkCanvas/InkTiles.ts`
- PDF（按页）：`src/components/PdfAnnotation/PdfCanvas.tsx`（tile 局部函数在文件里，`TILE`/`SCALE` 局部常量）
- 纯函数引擎：`src/components/PdfAnnotation/PdfEngine.ts`（两视图共用）
  - 注意：画布侧**另有** `InfiniteInkCanvas/StrokeEngine.ts`（含自己的 `getStrokeBounds`，**无缓存**）。
    只看 `PdfEngine.ts` 会漏掉它；两者不是同一份实现。

## 3. 已完成的优化（别倒退、别重复做）

1. **可滑动**：原来只有 pointerdown 点选删整笔；现在按住可拖，用线段↔笔画连续命中
   （`hitTestStrokeBySegment`，快甩不漏），一次手势 = 一条撤销历史。
2. **修"部分擦除后整笔擦会先复原"**：整笔擦命中**只认 source-over 墨笔**、跳过 destination-out 擦痕
   （否则误删擦痕 → 重建 → 被擦部分复活）。
3. **不整页重建**：每次删除只处理被删笔画**触及的区域**。
   - **【已改，比原文更省】** 现在不是"清掉整个 tile 再重画该 tile 内所有重叠笔画"，而是
     **只修复被删笔画的像素矩形**（`eraseStrokeRegions`）：在 scratch tile 上只重放与该矩形相交的幸存者，
     再把这一小块拷回。矩形外的像素原地保留。详见 §3.6。
4. **按动画帧合批**：拖动期间把 pointer 样本攒起来，每帧（requestAnimationFrame）只做一次扫描+删除，
   不再每条 pointermove 事件干活。
5. **拖动中不写 store**：删整笔先"视觉删"（清 tile 立刻消失），id 攒 `pendingIds`，抬手才一次性提交 store
   （避免拖动中每帧 React 重渲染）。
6. **空间哈希**：命中扫描与删除后重刷只查光标附近的 cell。
   - **【已改】** 不再是"一次手势开始时把所有笔画预哈希成 grid"（`addStrokeToGrid`/`collectGridStrokes`/`WIPE_CELL`
     这些符号**已不存在**）。现在哈希常驻在 **`InkStrokeIndex`**（`PdfAnnotation/InkStrokeIndex.ts`）里，
     随文档索引一次建好、之后增量维护（`add` 追加 / `remove` 剪枝），手势开始时只是拿到引用（`index.grid`）。
7. **【新增】烘焙倍率按显示密度自适应**：`BAKE_STEPS = [0.25, 0.5, 1, 2, 3]`，
   取 ≥ `zoom × dpr` 的最小档，带迟滞（升档 `BAKE_UP_RATIO=1.15`、降档 `BAKE_DOWN_RATIO=2.4`）。
   - 层的目标倍率：`setTargetBakeScale(tiles, deviceScale)` / `targetBakeScale(tiles)`（WeakMap 挂在 tiles Map 上）。
   - **每个 tile 自己的倍率**：`registerTileScale(canvas, s)` / `tileScaleOf(canvas)`（`InkRasterCache.ts`）。
   - **对整笔擦的影响**：修复矩形与回填的每个光栅都必须在**该 tile 自己的像素空间**里算，
     所以 `eraseStrokeRegions` 内部读 `tileScaleOf(canvas)`，外部传入的 `scale` 只是请求值/缺省值。
     **倍率传错不是"变糊"而是"墨迹错位"**，且有测试锁定（见 §10）。混合倍率是常态。
8. **【已改】结构操作不再是整页重建**：`renderEpoch` 变化时（`InfiniteInkCanvas.tsx:540`），
   处理为：新建 tiles Map → `indexInkStrokes()` 全篇索引（**只建索引，不建像素**）→ 设目标倍率 →
   `disposeTiles(旧)` → 懒材质化。
   - **同时清空进行中的手势**（`strokeEraseRef = null`、`selectDragRef = null`）。原因：手势抓着旧图层的
     index/grid/bounds，重建后那些 canvas 已释放（`width = 0`），后续修复会**静默变成空操作**——
     表现为"擦了没反应"。这条是硬要求，别丢。
9. **【新增】时间切片材质化**：每帧预算 `MATERIALIZE_BUDGET_MS = 6`（**时间**，不是 tile 数或字节数），
   单个 tile 的构建按笔画跨帧续做（`TileBuild`），**烤完才换上去**——永远不会露出烤了一半的 tile。
   淘汰与光栅缓存清理只在"画面停下且无手势"时做。

## 4. 现在为什么「局部高密度」还可能卡（剩余开销在哪）

做完 3~9 后，每帧开销从「O(总笔迹)」降到「O(光标附近的笔迹)」，所以：**一个屏幕区域里叠了大量笔画时，
每帧仍要处理这一大批**。剩余每帧/每删除的开销具体是：

- **命中扫描**：光标扫过的那几个 `HIT_CELL`（64 单位）cell 里可能有几十上百条笔迹 → 每条都要做
  精确线段测试（`InkStrokeIndex.hit`：先用 32 点分段的 block bbox 预筛，再逐段 `hitTestStrokeBySegment`）。
  笔画长时 cost = 点数。
- **删除后的局部修复**（`eraseStrokeRegions`）：对每个被删笔画，算出它触及的 tile 与其像素矩形，
  然后对每个脏矩形：`grid.get(key).filter(未删)` 取出该 tile 的幸存者（这一步是 O(tile 内笔画数)），
  再按 z 序只重放**与脏矩形相交**的幸存者（用逐笔缓存光栅 `getStrokeRaster`）。
  - `destination-out` 擦痕必须按序重放（否则 z 序错、擦痕效果丢），**没法跳过**。
  - 矩形外的像素原地保留，所以比"整 tile 重画"省得多；但密度极高时，一个脏矩形仍可能叠很多笔画。
- 极端情况：橡皮圈一次同时删掉十几条，等于连续做十几次"脏矩形修复"。
- 另外每帧还有一次 `scheduleRender → doRender`：重画视口内所有可见 tile + 背景（PDF 背景是大位图，比画布贵）。

## 5. 目标 / 验收

- **主目标**：在一个"一张纸上涂满、特别是一处叠了非常多笔迹/擦痕"的画布（以及同样密度的 PDF 页）里，
  按住「擦除笔画」来回滑，仍应明显跟手（目标 ≈ 每帧 CPU 连续阻塞 < ~12ms，别掉到几十一百毫秒）。
- 不能因为优化改变用户可见行为：
  - 碰到就整条消失（希望尽量即时）；如最终只能让步为"抬手批量删"，需要先征求用户，别擅自改交互。
  - 一次拖动 = 一条撤销；Ctrl+Z 一次还原该手势所有删除。
  - 被自由橡皮部分擦过的笔，整笔擦删掉时整条一次没、不闪回全笔。
  - destination-out 擦痕在删除后保留其语义（重画时 z 序正确）。
  - 画布与 PDF 都要改到（两处镜像）。
- 验收方式：
  ```
  cd D:\ClaudeCode_Project\NoteApp
  npm test                 # vitest，当前 320/320
  npx tsc --noEmit         # 当前 0 错误
  npm run dev              # 手动：造"极密"画布再滑橡皮看是否跟手
  ```

## 6. 千万别破坏的既有语义（改之前读一遍相关函数注释）

- **命中半径语义**：判定取"中心线距离 ≤ 半径"，半径 = `strokeEraserRadius(stroke.size, eraserDiameter?)`。
  - **【已改】** 半径不再固定 `ERASER_RADIUS(20)`：`eraserDiameter` 跟随工具栏橡皮大小。
    命中用的半径必须与画出来的橡皮圈一致（**block 预筛与精确测试必须用同一个半径**，否则圈内的擦不到）。
  - 命中只认 `source-over` 笔。
- 一次删除 = store **不 bump `renderEpoch`**，只改对象列表 + 手动修复 tile；
  undo 时 `renderEpoch` bump → 按 §3.8 重新索引（这条路径不用优化）。
- 矢量列表顺序 = z 序；destination-out 必须在**同一次重放中按其原始相对顺序**重放，
  先墨后擦、不能把擦痕单独跳过或提前。tile 桶（`index.grid`）**保留文档顺序**正是为此。
- 整笔擦的手势流程是"**视觉删 + 抬手提交**"：store 里的对象在抬手前保持不动，只有 tile 视觉变了；
  `pendingIds` 存手势内已删 id。别把这个模型弄丢（或改了要同步改 pointerup 提交与 undo）。
- **【新增】手势进行中绝不重建/回收 tile**（`inkGestureActive()`）。理由：整笔擦拖动期间被擦掉的笔迹
  **仍在索引里**（只靠 `pendingIds` 抑制），自由橡皮的擦痕要到抬手才写进 store——此时重建会**把已擦掉的墨迹复活**。
  - **已知缺口**：`inkGestureActive()` 只覆盖 `currentStrokeRef / strokeEraseRef / selectDragRef / isDrawingRef`，
    **漏了 `selectAnchorRef`（框选）**，两个视图都漏（`InfiniteInkCanvas.tsx:467`、`PdfCanvas.tsx:555`）。
    框选期间材质化链与升档重烤仍在跑，会与拖动抢帧。**待用户确认「拖动很卡」是否指框选后修**。
- **【新增】倍率必须记在 tile 上，不是记在这一层上**（§3.7）：所有写入方（盖章 / 自由擦 / 局部修复）
  都必须读所在 tile 自己的倍率。
- **【新增】tile 的像素永远是「索引（矢量源）在某倍率下的函数」**：任何 tile 都能随时丢弃重建，
  且重建结果与第一次逐字节相同（有测试锁定，是所有淘汰/重烤的安全依据）。
- **【新增】懒建 tile 不得被"创建"出来刷存在感**：自由橡皮只刻**已存在**的 tile（空 tile 没墨可刻，
  建它反而把一片从未构建过的区域标记成"已构建"，从而永久遮住那里的墨）。

## 7. 可参考的下一步方向（自行判断，不必照抄）

> 强烈建议：**先取数再改**。§9 的打点还在，先跑一轮拿到 `frames/scanned/erased/avgScan/worstScan/restamp`
> 的真实分布，确认大头是「命中扫描」「删除后修复」还是「整帧 doRender（背景/可见 tile）」，别盲改。

1. **命中更省**：`InkStrokeIndex.hit` 已是"block bbox 预筛 → 逐段精确"，若长笔迹仍是瓶颈，
   可把段块粒度从 32 点调细、或给段块也建一层空间索引。
2. **修复更省**：目前脏矩形修复里 `grid.get(key).filter(...)` 是 O(tile 内笔画数)。
   密度极高时可按"被删笔画的 z 段"只取它下方那些笔（它们才可能被它遮住），或把 tile 再分块。
3. **自适应降级**：检测每帧删除/修复预算超限时，短暂退化为"抬手或停顿才删"（连续高强度滑动时先只画圈反馈）。
   **交互改变需经用户同意。**
4. **整帧 doRender 的固定成本**（PDF 背景大位图、可见 tile 数）：`PdfCanvas.tsx` 每帧都会
   `strokesOnly(items[page])` 造一个新数组（O(总笔迹)），可按需局部绘制/缓存。
5. **框选门控缺口**（§6）：补上 `selectAnchorRef` 后，框选期间不再与材质化抢帧。

## 8. 关键代码位置

| 文件 | 内容 |
|---|---|
| `src/components/InfiniteInkCanvas/InfiniteInkCanvas.tsx` | 画布整笔擦：`strokeEraseRef`、`applyVisualErase`、`eraseTopmostAt`、`flushStrokeWipe`、`scheduleWipe`；pointerdown/move/up 三段里调用。`inkGestureActive` L467；结构操作 effect L540 |
| `src/components/InfiniteInkCanvas/InkTiles.ts` | `TILE`、烘焙档位（`BAKE_STEPS`/`bakeStepAtLeast`/`bakeStepFor`/`targetBakeScale`/`setTargetBakeScale`）、`stampStroke`、`indexInkStrokes`、`materializeTiles`、`evictDistantTiles`、`drawVisibleTiles`、`rebuildTiles`，以及 `removeStrokesFromTiles`（**L513，现为一行转发**） |
| `src/components/PdfAnnotation/InkTileErase.ts` | **`eraseStrokeRegions`：两视图共用的整笔擦局部修复**（脏矩形 + 按 tile 自己的倍率回填）。原 `InkTiles.removeStrokesFromTiles` 的内联实现搬到了这里 |
| `src/components/PdfAnnotation/InkStrokeIndex.ts` | **`InkStrokeIndex`：空间索引（TILE 桶保序 / 64 网格 + 32 点段块做命中）**、`getCommittedStrokeBounds`（WeakMap 缓存包围盒）、`getInkStrokeIndex` |
| `src/components/PdfAnnotation/InkRasterCache.ts` | 逐笔光栅缓存（LRU）+ **`registerTileScale`/`tileScaleOf`** + `getStrokeRaster`/`drawStrokeRaster` |
| `src/components/PdfAnnotation/PdfCanvas.tsx` | PDF 镜像：局部 `TILE = 512` / `SCALE = PDF_BAKE_SCALE`（**固定档，不随缩放**——页面面积有界，且页面背景按 3× 烘焙）、`removeStrokesFromInk`（L135，同样转发到 `eraseStrokeRegions`）、`strokeEraseRef`（多 page） |
| `src/components/PdfAnnotation/PdfEngine.ts` | 共用纯函数：`hitTestStrokeBySegment`（**签名已变**，多了 bounds/段区间/橡皮直径）、`strokeEraserRadius`、`isInkStroke/isEraserStroke`、`boundsIntersectRect`、`getStrokeBounds` |
| `src/components/InfiniteInkCanvas/useCanvasStore.ts` / `src/components/PdfAnnotation/PdfStore.ts` | store 动作 `beginEraseGesture`/`eraseStrokesLive`（画布）、`beginStrokeErase`/`eraseStrokesLive`（PDF）——这两个动作**不 bump renderEpoch**（见注释） |
| `src/components/PdfAnnotation/eraserPerf.ts` | dev-only 打点，§9 |
| `src/components/InkFrameStats.ts` / `DiagnosticPanel.tsx` | 帧读数（`Ctrl+Shift+D`），见 §9 |

已不再存在的符号（旧文档引用过）：`WIPE_CELL`、`addStrokeToGrid`、`collectGridStrokes`。

## 9. 复现 / 验证

```
cd D:\ClaudeCode_Project\NoteApp
npm test
npx tsc --noEmit
npm run dev
```
手动：在画布上画一堆互相交叠的笔迹（也留一些自由橡皮擦痕），再切「擦除笔画」按住快速来回滑，观察是否跟手/掉帧。

### 已内置 dev-only 打点（别删，测完再看着数据改）
`src/components/PdfAnnotation/eraserPerf.ts`：一次擦除手势结束时（pointerup）在 DevTools console 打一行：
`[eraser:canvas/pdf] frames=… scanned=… erased=… avgScan=…ms/frame worstScan=…ms restamp=…ms/erase totalRestamp=…ms`
只在 `npm run dev`（`import.meta.env.DEV`）生效，prod/vitest 是 no-op。
仍是本轮拿数的首选手段——`restamp` 就是 §4 的"删除后局部修复"。

### 帧读数（`Ctrl+Shift+D`）
顶部第一块「墨迹性能」给出 缩放/烘焙倍率/tile 数/屏上数/MiB、**平移/缩放帧间隔**（p50/p95/worst/掉帧计数）、
写字/其它重绘帧间隔、**墨迹绘制**耗时。
- 采样挂在墨迹层自己的渲染循环上（`noteInkFrame`），**面板开不开都在采样**——面板是覆盖层，
  开着就没法操作画布，所以流程是：开面板 → 重置 → 关面板 → 操作 → 再开面板看。
- **读数陷阱**：
  - `墨迹绘制` 的统计范围两个视图**不一致**：画布侧含拖动预览/框选高亮/实时笔/激光；
    PDF 侧 `reportInkFrame` 在 `drawVisibleTiles` 之后立刻上报，**拖动预览与选中框都不计入**。
    所以 PDF 上"`墨迹绘制` 很小但帧率很差"**不能**排除拖动路径。
  - 画布侧 `noteCameraMove()` 挂在 deps 含 `objects`/`selectedIds`/`activeTool` 的 effect 上，
    所以**选区或对象一变，接下来 150ms 的帧会被记为"相机移动中"**，可能把拖动帧误记进"平移/缩放"那一行。

## 10. 测试里锁住的不变量（改代码时别破坏）

位于 `src/components/InfiniteInkCanvas/__tests__/InkTiles.lod.test.ts`（10 个用例）与
`PdfAnnotation/__tests__/StreamingInk.test.ts`（22 个用例）等，与擦除直接相关的：

1. **非 3× 倍率下，整笔擦的局部修复结果 = 同倍率下整页重建**（抓"倍率传错导致墨迹错位"）。
2. **就地重烤后 = 按目标倍率新建**（逐字节）。
3. **淘汰后重建 = 首次构建**（逐字节）。
4. **被 `skipIds` 抑制的笔迹不会被复活**（抓"擦除中被重建"）。
5. **一次 pass 有界且可续做**：`budgetMs:0` 时 `materialized=0`、`remaining>0`，
   且 tiles 里不允许出现尺寸不对的半个 tile。
6. **盖章写入所在 tile 自己的倍率，而不是目标倍率**。
7. **自由橡皮擦痕与撤销/重做的 z 序与命中性**（`StreamingInk.test.ts` 的 free-eraser order 用例）。

> 若要动 store 里 `eraseStrokesLive` 的"不 bump epoch"约定，先读 `useCanvasStore.ts` / `PdfStore.ts`
> 里这两个动作和注释，别破坏视觉删 + 抬手提交 + undo 的关系。
