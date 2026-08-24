# CallChain · Electron 重写设计

**日期**: 2026-08-20
**状态**: 历史设计基线；核心链路已在 Electron 1.1 部分落地，后续实施以
[开发路线图](../../DEVELOPMENT_ROADMAP.md) 为准
**作者**: brainstorming 协作产物（用户 + 助手）

---

## 1. 项目定位与范围

### 1.1 一句话定位

面向 vibecoder 的代码导航与理解工具——以 Monaco 只读代码查看器为中心，ctrl/cmd+点击函数名，右侧立即生成精确的调用链图。

### 1.2 Phase 1 范围（本设计覆盖）

- Electron 桌面应用，打包为 Windows exe（主）+ macOS app
- Monaco 只读多标签代码查看器
- ctrl/cmd+点击函数名 → 右侧立即重建调用链图
- tree-sitter 精确解析（TS/JS + Python + Java/Kotlin）
- 左右分层布局，图优先
- 磁盘缓存（mtime + 大小校验，增量重扫）
- 保留功能：导出 PNG、函数作用说明
- 砍掉：侧栏搜索框、CLI 模式

### 1.3 明确不在 Phase 1

- 类/类型点击、变量数据流、import 模块图（留作后续 Phase）
- 移动端（PC/Mac 稳定后再考虑，但分层架构预留）
- 代码编辑、保存（只读）

### 1.4 已知缺口（Phase 1.x 候选）

砍掉搜索框后缺少「我知道函数名但不知道在哪个文件」的全局查找能力。Phase 1.x 用 Monaco ⌘P（快速打开文件）部分缓解，后续可补全局符号查找。

---

## 2. 架构分层

三层进程模型，职责严格分离。UI 层与计算层解耦，为后续迁移动端留基础。

### 2.1 进程拓扑

```
┌─────────────────────────────────────────────────────────┐
│  渲染进程 (Renderer, Web)                                │
│  ┌─────────────────┐  ┌──────────────────────────────┐ │
│  │  UI 层 (React)   │  │  Web Worker: analyzer         │ │
│  │  - Monaco 查看器 │  │  - tree-sitter wasm 解析     │ │
│  │  - 调用链图(SVG) │  │  - 调用图构建 (双向 BFS)      │ │
│  │  - 检查器        │  │  - 函数作用推断              │ │
│  │  - 抽屉/标签      │  │  - 不阻塞 UI                  │ │
│  └────────┬────────┘  └───────────┬──────────────────┘ │
│           │  postMessage           │  postMessage        │
└───────────┼────────────────────────┼─────────────────────┘
            │                        │
            │  IPC (contextBridge)   │
            ▼                        ▼
┌─────────────────────────────────────────────────────────┐
│  主进程 (Main, Node)                                     │
│  - 文件 IO: 读目录、读文件、watch 变动                   │
│  - 缓存管理: ~/.callchain/cache/<项目hash>/              │
│    校验(mtime+size)、序列化、增量重扫                     │
│  - 系统能力: 打开外部编辑器、保存 PNG                     │
│  - 窗口/菜单/生命周期                                    │
└─────────────────────────────────────────────────────────┘
```

### 2.2 分层原则

- **渲染进程**：纯 Web 标准（React + Monaco + SVG），不直接调任何 Node/Electron API。所有系统能力通过 `contextBridge` 暴露的受控 IPC 调用。这样 UI 层将来可整体迁到浏览器/PWA/移动 WebView。
- **Web Worker**：解析与图构建独立线程，UI 不卡顿。tree-sitter wasm 与语言 grammar wasm 都在这里加载。
- **主进程**：唯一的系统能力出口——文件、缓存、原生对话框、窗口。跨平台差异（路径分隔符、可执行路径）收敛在这一层。

### 2.3 数据流：点击函数名 → 看到图

1. 用户在 Monaco 按住 ⌘ 并点击函数名 token
2. 渲染进程从 Monaco 拿到 `{token, file, line, col}` → 发给 Worker `analyzeSymbol`
3. Worker 从已解析的语法树索引里查该函数定义，双向 BFS 构建调用图
4. Worker 返回 `{nodes, edges, anchor, insights}` → 渲染进程更新 SVG 图 + 检查器
5. 全程主进程不参与（除非要读尚未解析的文件）

### 2.4 首次打开项目流程

1. 主进程扫描目录树 → 返回文件列表给渲染进程
2. 渲染进程把文件列表发给 Worker
3. Worker 逐文件读内容（向主进程 IPC 请求 `readFile`）、解析、建索引
4. Worker 把索引序列化交主进程写缓存
5. 二次打开：主进程校验缓存，未变动的文件直接用缓存索引，仅变动文件交给 Worker 重扫

---

## 3. 解析与调用图模型

### 3.1 文件 → 语法树 → 符号

**tree-sitter 查询语言**统一抽取四类符号（用 tree-sitter 的 query DSL，每种语言一份 `.scm` query 文件）：

| 符号类型 | 节点 | 含义 |
|---|---|---|
| **FunctionDefinition** | `function_declaration` / `method_declaration` 等 | 函数定义，带名称、起止行、所属类 |
| **FunctionCall** | `call_expression` + `function` 子节点 | 函数调用点，带文件、行、列、所属函数 |
| **ClassDefinition** | `class_declaration` | 类/类型（Phase 1 仅建立归属，不参与图） |
| **Import** | `import_statement` | 模块依赖（Phase 1 不参与图） |

### 3.2 符号 ID（核心，解决同名重载）

现有 Swift 版按函数名字符串匹配，同名重载全部混连。新版用 **qualified id**：

```
FunctionSymbol.id = lang::filePath::className::name::paramTypeSignature
```

例如 `ts::src/auth.ts::AuthManager::saveSession::(string, Session)` 与 `ts::src/cache.ts::Cache::saveSession::(string)` 是两个不同节点，不再混连。

**调用解析**：调用点 `(file, line, col, calleeName)` 通过两层查找绑定到定义：
1. 同文件作用域内的局部函数（tree-sitter 作用域查询）
2. 全局 `name → [FunctionSymbol]` 索引；若多于一个，按参数数量/类型签名打分选最佳，无法确定时标记 `unresolved-ambiguous`（在检查器显式提示）

这是相比现有正则版最大的精度提升——**真正可区分重载**。

### 3.3 调用图模型

```
Graph {
  anchor: FunctionSymbol        // 锚点（用户点击的函数）
  nodes: Map<Id, GraphNode>
  edges: Map<Id, GraphEdge>     // 边的 id = fromId + "->" + toId
  unresolved: CallSite[]        // 没找到定义的调用点
  bounds: Rect                  // 布局后的包围盒
  isTruncated: Bool             // 是否达安全上限
}

GraphNode {
  id: string
  def: FunctionSymbol
  level: Int     // 0=锚点，>0=被调用者(右)，<0=调用者(左)
}

GraphEdge {
  from, to: string
  sites: CallSite[]  // 所有该调用发生的位置（可多个）
}

CallSite { file, line, col, code, callerFunctionId }
```

### 3.4 双向 BFS 构建（左右分层对应）

调用者向上、被调用者向下，各走 `callerDepth` / `calleeDepth` 层：

```
buildGraph(anchorId, callerDepth, calleeDepth):
  visited = Set()
  queue = [(anchorId, 0)]
  while queue:
    (id, level) = queue.pop()
    if id in visited: continue
    visited.add(id)
    node.level = level

    // 向下（被调用者，level +1，右）
    if level < calleeDepth:
      for callee in callsByCallee[id]:
        edges.add(from=id, to=callee.id, sites=callee.sites)
        queue.push((callee.id, level+1))

    // 向上（调用者，level -1，左）
    if level > -callerDepth:
      for caller in callsByCaller[id]:
        edges.add(from=caller.id, to=id, sites=caller.sites)
        queue.push((caller.id, level-1))
```

**安全上限**（沿用现有策略的稳健性）：节点数硬上限（如 300）、边数上限（如 500），超限截断并标 `isTruncated`，避免巨型图拖垮渲染。

### 3.5 函数作用说明（保留功能）

沿用现有「注释优先 + 离线推断」策略，但精度提升（基于语法树而非正则）：

- **basis = sourceComment**：取函数定义上方的 doc comment（各语言格式：TS `/** */`、Python `""" """`、Java `/** */`、Kotlin `/** */`，tree-sitter query 抽取）
- **basis = inferred**：缺失注释时，按函数名语义 + 函数体调用的关键函数 + 返回/副作用推断（如调用 `save*`/`write*`/`fs.*` → 推断为持久化）
- 所有推断都标注依据，可在检查器核对

### 3.6 Phase 1 语言 query（每种一份 .scm）

- `typescript.scm` / `javascript.scm`
- `python.scm`
- `java.scm` / `kotlin.scm`

加新语言只需新增 `.scm` + 加载对应 grammar wasm，**解析引擎与图构建逻辑不变**（这是选 tree-sitter 的核心红利）。

---

## 4. UI 与交互

### 4.1 主窗口布局（两栏 + 抽屉）

```
┌──────────────────────────────────────────────────────────────┐
│  ◉◉◉  CallChain · ~/Projects/coros_app        ⌘O 打开  ⌘\ 树 │  ← 顶栏
├───────────┬───────────────────────────────────┬──────────────┤
│           │                                   │              │
│  项目树    │  代码查看器 (Monaco, 只读)        │ 调用链图(SVG) │
│  (抽屉)   │  ┌─[auth.ts]─[store.ts]─[+x]      │              │
│  默认隐藏  │  │ func saveSession(s: Session)  │ 左=调用者    │
│  ⌘\ 唤出   │  │   encrypt(s.token)  ← ⌘点    │ 中=锚点      │
│           │  │   writeStore(s)      ← ⌘点    │ 右=被调用者  │
│  ▾ src/   │  │ }                            │              │
│    auth.ts│                                   │ [适配] [导PNG]│
│    store  ├───────────────────────────────────┤              │
│  ▾ tests/ │                                   ├──────────────┤
│           │                                   │ 详情检查器    │
│           │                                   │ (选中节点)    │
└───────────┴───────────────────────────────────┴──────────────┘
   220px        可拖拽                              可拖拽
```

- **抽屉**：默认隐藏，⌘\ 或顶栏按钮唤出。打开后覆盖在代码左侧（不挤压代码区），点抽屉外或再按 ⌘\ 收起
- **分隔条**：代码 | 图 区可拖拽调整比例，记住上次比例
- **空状态**：未打开项目时，居中显示「⌘O 打开一个项目目录」

### 4.2 代码查看器（Monaco 只读 + 多标签）

**多标签**：
- 顶栏一行 tab：`[auth.ts ×] [store.ts ×]`，点 × 关闭；点项目树文件即在当前 tab 组打开新 tab（或激活已打开的 tab）
- 切换 tab 记住每个文件的滚动位置与光标
- 上限 8 个 tab，超过时最旧的自动关闭（LRU）

**只读模式**：`readOnly: true`，但保留语法高亮、代码折叠、minimap、行号、⌘F（文件内查找）

### 4.3 ⌘+点击交互（核心）

**触发**：用户按住 ctrl（Win）/ cmd（Mac）+ 鼠标左键点 Monaco 里的 token

**可点击 token 类型（Phase 1）**：函数定义名、函数调用名（即 FunctionDefinition 与 FunctionCall 对应的 identifier 节点）

**按键提示样式**：
- 监听 `keydown/keyup` 的 ctrl/cmd 状态
- 按住时，给 Monaco 里所有可点击 token 加 CSS class `.callchain-clickable`：`text-decoration: underline; color: var(--accent); cursor: pointer`
- 松开时移除 class
- 实现：Monaco `decorations` API 动态增删

**点击响应**（立即重建）：
1. Monaco `onMouseDown` + 检测修饰键 → 从 `position` 拿到 `{line, col}` → 通过 tree-sitter token 映射查到该位置的 symbol
2. 若不是函数 token → 忽略（无视觉反馈，避免误导）
3. 若是 → 发给 Worker `buildGraph(symbolId)` → 收到结果更新右侧图
4. 锚点行在 Monaco 里高亮（`decorations` 加背景色），并在图里 level=0 节点高亮

**鼠标悬停（非必需辅助）**：函数 token 上悬停 ~500ms 弹出 tooltip「⌘+点击查看此函数的调用链」

### 4.4 调用链图（SVG, 左右分层）

**布局算法**：
- 锚点放中列（x=0）
- 调用者放左列（x=-1, -2, ...，按 level 递减）
- 被调用者放右列（x=+1, +2, ...，按 level 递增）
- 同列内节点纵向堆叠，按调用关系聚类（同调用方的尽量靠近）
- 边用贝塞尔曲线，避免直线交叉；同层调用者→锚点 边统一向右弯

**视觉编码**：
- 锚点：粗边框 + 蓝色填充
- 调用者节点：橙色边框
- 被调用者节点：绿色边框
- 多调用点边：粗边，悬停显示「×N 处调用」
- 未解析调用：虚线 + 灰色

**交互**：
- 拖拽空白处平移
- 滚轮 / 双指缩放（以鼠标为中心）
- 单击节点 → 选中，检查器显示详情
- 双击节点 → 以该节点为新锚点重建图（等价于在代码里点它）
- 双击空白 → 适配视图（fit bounds）
- 悬停边 → tooltip 显示调用点列表

**深度控制**（顶栏）：上层深度 `-` `2` `+`，下层深度 `-` `2` `+`，范围 1–5；「完整链」开关走全可达图（受安全上限保护）

### 4.5 详情检查器（右下）

选中节点后显示：
1. **节点头**：图标 + 函数名 + 所属类 + 文件:行 + 「以它为中心」「打开文件」按钮
2. **函数作用**（保留功能）：注释优先，缺失时离线推断；标注 basis（来源注释/推断）
3. **调用关系**：它调用了谁（出边）、谁调用了它（入边），每条边显示调用点数量；点调用点 → Monaco 跳转到该位置并高亮
4. **未解析调用**：orange 提示，列出未能绑定的调用点

未选中时：占位文字「单击图中的节点查看详情」

### 4.6 导出 PNG（保留功能）

「导出 PNG」按钮 → 按 SVG 包围盒序列化为高分辨率 PNG（2x scale）→ 系统保存对话框 → 写文件。文件名默认 `<锚点函数名>.png`。

### 4.7 快捷键

| 键 | 作用 |
|---|---|
| ⌘O | 打开项目目录 |
| ⌘\ | 切换项目树抽屉 |
| ⌘W | 关闭当前 tab |
| ⌘B | 适配视图 |
| ⌘E | 导出 PNG |
| ⌘+ / ⌘- | 图缩放 |
| Esc | 取消选中节点 |

### 4.8 状态反馈

- 扫描中：图区显示进度「已解析 234/1820 文件」
- 解析错误：单文件解析失败不阻塞，在检查器「未解析」区显示文件与错误
- 缓存命中：打开项目时若全部命中缓存，瞬时进入可用状态

---

## 5. 缓存与性能

### 5.1 缓存布局

```
~/.callchain/cache/
└── <projectHash>/                    # projectHash = SHA1(绝对路径)
    ├── manifest.json                # 项目元信息 + 文件索引
    └── files/                       # 每个源文件一份序列化解析结果
        ├── <fileHash1>.json         # fileHash = SHA1(相对路径)
        └── <fileHash2>.json
```

**manifest.json**：
```json
{
  "projectPath": "/Users/.../coros_app",
  "createdAt": "...",
  "appVersion": "1.0.0",
  "files": {
    "src/auth.ts":   { "mtime": 1787000000, "size": 2341, "hash": "ab12...", "parseFile": "ab12....json" },
    "src/store.ts":  { "mtime": 1786900000, "size": 1820, "hash": "cd34...", "parseFile": "cd34....json" }
  }
}
```

**单文件解析结果**（`<fileHash>.json`）：tree-sitter 语法树抽取的符号表——所有 FunctionDefinition / FunctionCall / ClassDefinition / Import，含位置、签名、所属类。**不存原始语法树**（太大），只存抽取出的符号（小得多）。全局符号索引在 Worker 内存里由所有文件解析结果合并而成，不需要单独的 `symbols.bin`——打开项目时从 `files/` 重建即可。

### 5.2 校验与增量重扫

打开项目时主进程执行：

```
loadProject(path):
  manifest = readManifest(path) or empty
  diskFiles = scanDisk(path)              // 排除 hidden/build/node_modules

  for file in diskFiles:
    stat = stat(file)
    cached = manifest.files[file]
    if cached && cached.mtime == stat.mtime && cached.size == stat.size:
      // 命中缓存，标记为 reuse
      cachedFiles.add(file)
    else:
      // 变动或新增，标记为 reparse
      changedFiles.add(file)

  deletedFiles = manifest.files.keys - diskFiles

  // 把 changedFiles 交给 Worker 重扫，cachedFiles 直接读缓存符号
  Worker.reparse(changedFiles) → merge into symbolIndex
  Worker.loadCached(cachedFiles) → merge into symbolIndex

  // 更新 manifest，删除已删文件的缓存
  writeManifest(newManifest)
  cleanupCache(deletedFiles)
```

**为什么 mtime + size 而非内容 hash**：内容 hash 要全文件读+哈希，与重新解析成本相当，没意义；mtime+size 是 O(1) stat 调用，对内容变动足够灵敏（罕见情况：mtime 回退或原地改内容不改 size——可接受，下次解析能修正）。

**跨设备同步陷阱**：mtime 在 git/同步盘上不可靠（同步会重置 mtime）。Phase 1 不处理，若用户反馈再说。在 manifest 里记 `appVersion`，升级 tree-sitter 或 schema 变化时整体失效重扫（版本号对比）。

### 5.3 解析并发

**Web Worker 内**：单线程顺序解析（tree-sitter wasm 是同步的）。但 Worker 不阻塞渲染进程，UI 始终可交互。

**批处理 + 增量反馈**：
- Worker 每解析完一批（如 50 文件）通过 `postMessage` 报告进度
- 渲染进程在图区底部显示「已解析 234/1820 文件」，已可对已解析文件发起 ⌘+点击查询（不必等全扫完）
- 大项目（>4000 文件）超过 15 秒硬超时，已解析部分可用，剩余文件在后台继续扫

### 5.4 性能上限（沿用现有稳健策略）

| 维度 | 上限 | 超限行为 |
|---|---|---|
| 扫描文件数 | 4000（可配置） | 超出部分跳过，状态栏提示 |
| 单文件大小 | 2.5 MB | 跳过解析，标记 `too-large` |
| 扫描超时 | 15 秒 | 已解析部分可用，继续后台扫 |
| 调用图节点 | 300 | 截断，标 `isTruncated` |
| 调用图边 | 500 | 截断 |
| 单文件符号数 | 2000 | 截断（防止生成代码拖垮索引） |

**扫描排除**：默认排除 `node_modules/` `build/` `dist/` `.git/` `target/` `DerivedData/` 及所有 hidden 目录；可通过项目根目录 `.callchainignore` 覆盖（语法同 `.gitignore`，Phase 1 可不实现，用默认即可）。

### 5.5 缓存清理

- 不主动清理：磁盘空间用 `du` 检查，超阈值（如 500 MB）时提示用户，但**不自动删**（避免误删有用缓存）
- 用户可在设置/菜单「清理缓存」手动清空全部
- 项目目录被删除时，对应缓存自然失效（下次打开不存在了），但缓存文件残留——可在打开历史里检查并清理已不存在项目的缓存（Phase 1.x）

### 5.6 内存占用

- 符号索引常驻 Worker 内存：约 200 字节/符号 × 平均 100 符号/文件 × 4000 文件 ≈ 80 MB（可接受）
- Monaco 每个打开的 tab 加载文件内容：约 2.5 MB × 8 tab ≈ 20 MB
- SVG 图：典型调用链图 50–150 节点，DOM 节点约 500–2000，可忽略
- 总目标：< 300 MB 常驻（Electron 基础占用约 150 MB，应用增量 < 150 MB）

---

## 6. 错误处理与测试

### 6.1 错误分级与处理策略

| 级别 | 场景 | 处理 |
|---|---|---|
| **致命** | 主进程启动失败、Electron 加载失败 | 弹原生对话框 + 退出 |
| **项目级** | 目录无法读、无权限 | 顶栏错误条 + 引导用户重选目录 |
| **文件级** | 单文件解析失败（语法错误/编码问题） | 不阻塞，文件标记 `parse-error`，检查器「未解析」区列出，可点开看错误 |
| **操作级** | ⌘+点击的 token 解析不到符号 | Monaco 临时浮层提示「未找到 saveSession 的定义」，图区不变 |
| **图级** | 调用图超安全上限截断 | 正常显示已构建部分，顶栏标记「已达安全上限」 |
| **缓存级** | 缓存读取失败/损坏 | 删除该条缓存，重新解析该文件，记日志 |

**原则**：单点失败不阻断整体流程。解析一个坏文件不该让用户看不到其他好文件的调用链。

### 6.2 解析鲁棒性

tree-sitter 本身对语法错误有容错（能在错误附近继续解析），但仍要防御：
- **编码**：默认 UTF-8，读取失败时尝试 GBK / Shift-JIS（Win 中文/日文项目常见），都失败则跳过并记 `encoding-unsupported`
- **BOM**：自动剥离
- **超大行**：单行 > 10 KB 时跳过该行的语法树查询（防 tree-sitter 在压缩/生成代码上耗时）
- **二进制误识别**：读前 8 KB 检测 NUL 字节，命中则标记 `binary-skip`

### 6.3 IPC 通信健壮性

- 所有 IPC 调用带 `requestId`，渲染进程可对超时（如读文件 5 秒）做兜底
- 主进程向渲染进程推消息（如文件 watch 检测到变动）走 `webContents.send`，渲染进程订阅
- contextBridge 只暴露最小 API 面（`openProject`、`readFile`、`saveFile`、`openExternal`），不暴露 `require` / `eval` / 任意路径访问

### 6.4 测试策略

**三层测试**，从内到外：

#### 层 1：单元测试（解析与图构建，纯逻辑，最快最稳）

复用现有 `AnalyzerTests` / `FunctionExplainerTests` 的思路，移植到 TS + Vitest：

- **解析测试**：每种语言一份 fixture 项目（小代码片段），断言抽出的 FunctionDefinition / FunctionCall 正确。期望值在每个 fixture 旁以 `.expected.json` 形式手写，测试加载并与解析结果对比
  - `fixtures/ts/auth.ts` + `auth.expected.json`
  - `fixtures/py/models.py` + `models.expected.json`
  - `fixtures/java/AuthManager.java` + `AuthManager.expected.json`
  - `fixtures/kotlin/Repo.kt` + `Repo.expected.json`
- **重载区分测试**：同名不同签名的两个函数，断言生成两个不同 qualified id，调用点正确绑定到各自
- **调用图构建测试**：给定 anchor，断言 BFS 产出的 nodes/edges 正确，含正负 level
- **安全上限测试**：构造超大图，断言截断且 `isTruncated=true`
- **函数作用推断测试**：给定无注释函数，断言推断结果与依据

#### 层 2：缓存测试

- 增量重扫：修改一个文件 mtime，断言仅该文件重扫、其他命中缓存
- 缓存失效：改 appVersion，断言全部重扫
- 缓存损坏：手动改坏一个 `<fileHash>.json`，断言该文件重扫不崩溃

#### 层 3：端到端测试（Electron）

用 Playwright + Electron 跑冒烟流程：
- 启动 → ⌘O → 选 fixture 项目 → 项目树出现
- 打开文件 → ⌘+点击函数名 → 右侧图出现，节点数正确
- 双击节点 → 图重建
- 导出 PNG → 文件生成
- 关闭重开 → 缓存命中，瞬时可用

### 6.5 测试覆盖目标

- 解析逻辑（层 1）：> 85% 行覆盖
- 图构建逻辑（层 1）：> 90%
- 缓存逻辑（层 2）：关键路径全覆盖
- 端到端（层 3）：核心 happy path 全覆盖，不追求边角覆盖

### 6.6 日志

- 主进程：写 `~/Library/Logs/CallChain/main.log`（macOS）/ `%APPDATA%/CallChain/logs/main.log`（Win），按天 rotate
- 渲染进程：`console` + 通过 IPC 转发到主进程日志（生产环境默认 info，调试可开 debug）
- Worker：解析错误带 `{file, line, error}` 通过 IPC 转发
- 用户可菜单「查看日志」打开日志目录

---

## 7. 关键决策汇总

| 维度 | 决策 |
|---|---|
| 技术栈 | Electron + React + Monaco + Web Worker + tree-sitter wasm |
| 范围 | 函数调用链（类/变量/模块留后续） |
| 代码查看器 | Monaco 只读 + 多标签 |
| 交互 | ⌘+点击立即重建，按键时加下划线 |
| 图样式 | 左右分层 SVG + 贝塞尔边 |
| 布局 | 两栏(代码\|图) + 项目树抽屉 |
| 解析 | tree-sitter query + qualified id 区分重载 |
| 缓存 | mtime+size 增量，磁盘序列化 |
| 语言 | TS/JS + Python + Java/Kotlin |
| 保留功能 | 导出 PNG、函数作用说明 |

---

## 8. 与现有 Swift 版的关系

这是一次**重写**，不是修改。现有 Swift 代码不复用，但以下知识与策略延续：

- **双向 BFS 调用图构建算法**（CallGraph.swift）→ 移植到 TS，逻辑等价
- **安全上限策略**（节点 300/边 500/扫描 4000 文件/单文件 2.5MB/15 秒超时）→ 沿用
- **函数作用「注释优先 + 离线推断」策略**（FunctionExplainer.swift）→ 移植到 TS，基于 tree-sitter 重写注释抽取
- **左右分层布局思路**（现有是上下分层，新版改左右）→ 布局算法重写为横向

现有 Swift 版可作为**算法参考**与**测试 fixture 来源**（已有的 fixture 项目可移植）。
