# CallChain 后续开发路线图

> 基线日期：2026-08-25
>
> 当前主线：`electron/`（Electron + React + Monaco + tree-sitter wasm）
>
> 早期 `Sources/` SwiftUI 版本进入维护模式，仅保留回归验证与算法参考。

## 1. 当前基线

Electron 版已经具备可演示的核心闭环：打开目录、项目树、多标签只读代码查看、
5 种语言的 tree-sitter 解析、修饰键点击函数、双向调用图、渐进展开、路径高亮、
Minimap、详情面板与可见节点聚合。当前验证基线如下：

```bash
cd electron && npm run verify  # 类型检查、生产构建、解析与图逻辑测试通过
cd .. && swift test            # Swift 版 26 项回归测试通过
```

需要注意，现有 `electron/scripts/test-e2e.mjs` 是解析、绑定和构图的进程内集成测试，
并没有启动 Electron，也没有覆盖真实的目录选择、Monaco 点击、IPC 和导出流程。

## 2. 开发原则

1. **Electron 是唯一产品主线。** 新功能默认只进入 `electron/`；Swift 版除严重回归外不再扩展。
2. **先建立发布底座，再扩展功能。** 可靠性、安全性、自动化测试和跨平台产物优先于新增语言或复杂图能力。
3. **解析结果必须可解释。** 无法唯一绑定的调用不能静默选第一个候选，应保留歧义状态和候选依据。
4. **大项目必须可取消、可增量。** 所有项目级任务需要项目会话 ID，旧任务不得污染新项目状态。
5. **每个里程碑独立可交付。** 完成条件以可重复命令或真实用户流程验证，不以“代码已写完”为准。

## 3. 优先级路线

### M0：稳定当前主链（P0）

目标：消除会导致错误结果、卡死或跨项目串数据的问题，为后续测试和缓存建立稳定协议。

#### 3.1 收紧扫描与语言边界

- 将“可在 Monaco 打开”和“可被分析器解析”的扩展名拆成两个集合。
  当前 `swift/css/html/json/md` 会被收集后回落为 TypeScript 解析，应改为只把
  `ts/tsx/js/jsx/mjs/py/java/kt/kts` 送入分析器。
- 在主进程扫描阶段真正执行 4000 文件、2.5 MB 单文件和 15 秒扫描预算，返回
  `accepted/skipped/reason` 统计，而不是只声明常量。
- 让读取失败、二进制、超大文件和不支持编码也推进解析进度，避免进度永久停在 `N-1/N`。

验收：混合语言 fixture 中非支持文件不进入解析队列；每一种跳过原因都有测试；进度最终必达 100%。

#### 3.2 引入项目会话与请求关联

- 为 `parseProject`、`parseFile`、`resolveSymbolAt`、`buildGraph` 增加 `projectSessionId/requestId`。
- Worker 收到新项目会话后丢弃旧会话消息；打开第二个项目时可以取消第一轮解析。
- 将 `useAnalyzer` 当前按消息类型保存单个回调的方式改为按 `requestId` 管理，补充超时与卸载清理。
- 将 Worker 串行队列收敛为唯一入口，避免 `handle()` 与 `flushPending()` 交叉执行。

验收：解析中连续切换两个 fixture 项目，最终符号、进度和图只属于第二个项目；连续快速点击多个符号均返回对应结果。

#### 3.3 修正符号解析的歧义语义

- `findSymbolAt` 不再对未绑定调用直接取同名候选的第一个，而是返回
  `resolved / ambiguous / unresolved` 及候选列表。
- 完善同文件、类作用域、import/包、参数数量和类型签名的分层打分，并把解析依据展示到详情面板。
- 为重载、同名跨文件、类方法、成员调用、Kotlin 安全调用和递归调用建立固定 fixture。

验收：同名函数的选择与 fixture 期望一致；不能确定时 UI 明确提示，不生成看似精确的错误调用链。

#### 3.4 收口 Electron 安全边界

- IPC 读取路径必须在已授权项目根目录内；拒绝 `..`、绝对路径逃逸和符号链接越界。
- `openExternal` 只允许打开当前项目中的文件；所有 IPC 参数做运行时校验。
- 调研并移除生产环境全局 `webSecurity: false`，优先用自定义安全协议或明确的本地资源映射加载 wasm。
- 增加严格 CSP，保留 `contextIsolation: true`、`nodeIntegration: false`，评估恢复 sandbox。

验收：路径穿越测试被拒绝；打包应用仍能加载所有 grammar wasm；Electron 安全检查无高危项。

### M1：建立可信测试与 CI（P0）

目标：把“本机脚本能跑”升级为“每次提交都能证明核心流程没坏”。

- 引入正式测试运行器（建议 Vitest），把解析器、resolver、graphBuilder、layout 和 labels
  的脚本断言迁为可发现、可筛选、可输出覆盖率的测试。
- 按语言建立 fixture + expected 结果，避免测试脚本复制生产 query。
- 引入 Playwright Electron 冒烟测试，至少覆盖：启动、打开 fixture、文件树、Monaco 加载、
  修饰键点击、生成图、节点重锚、项目切换、错误提示和导出。
- 建立 GitHub Actions：Linux 跑类型检查/单元测试，macOS 跑 Swift 回归和 Electron 冒烟，
  Windows 跑 Electron 冒烟与安装包构建。
- 将 `npm run verify` 作为本地与 CI 的统一入口，并输出测试报告与覆盖率。

验收：PR 必须通过三平台矩阵；解析与图构建分别达到 85%/90% 行覆盖；真实 Electron happy path 可重复通过。

### M2：缓存、增量与大项目性能（P1）

目标：二次打开接近即时可用，文件变更无需全量重扫。

- 按原设计实现 `appVersion + schemaVersion + mtime + size` 的单文件解析缓存。
- 主进程负责 manifest、原子写入、损坏回退和缓存清理；Worker 只消费/产出可序列化符号结果。
- 增加文件 watch，批量防抖后只重扫新增或变更文件，并删除已移除文件的索引。
- 对扫描、读取、解析、索引重建和首图耗时埋点；建立小/中/大三个基准 fixture。
- 优化产物体积：当前构建中主 bundle 约 4.6 MB、TypeScript worker 约 6.9 MB，
  应按语言与 Monaco worker 按需加载，grammar wasm 也按项目实际语言加载。

验收：未变项目二次打开不重新解析；单文件修改只重扫该文件；缓存损坏自动降级；大项目内存和耗时有可追踪基线。

### M3：补齐 Phase 1 产品闭环（P1）

目标：把已经暴露但未接通的系统能力变成完整用户流程。

- 实现调用图 PNG 导出：按 SVG bounds、2x 比例渲染，使用系统保存对话框并验证产物。
- 详情面板接通“打开文件/跳到调用点”，优先支持应用内 Monaco 定位，再提供外部编辑器跳转。
- 增加 `Cmd/Ctrl+P` 快速打开与全局符号查找，解决“知道函数名但不知道文件”的入口缺口。
- 支持代码区/图区拖拽分栏并持久化比例；补齐 `Cmd/Ctrl+W/B/E/+/-` 快捷键。
- 汇总解析失败、跳过文件、未解析和歧义调用，提供可筛选的诊断视图。

验收：设计文档 4.1–4.8 中列入 Phase 1 的交互均有实现或明确降级说明，关键流程有 Electron E2E。

### M4：跨平台发布（P1）

目标：产出可安装、可升级、可追踪问题的 Windows 与 macOS 版本。

- `electron-builder` 增加 Windows x64/arm64 配置与安装器；macOS 同时覆盖 arm64/x64 或 universal。
- 确认路径分隔符、快捷键、字体、窗口标题栏、编码和长路径在 Windows 上的行为。
- 建立版本号、CHANGELOG、构建产物校验和、发布说明与回滚流程。
- 配置代码签名、公证和崩溃日志；签名密钥只进入 CI secret，不进入仓库。

验收：干净的 Windows 与 macOS 环境可以安装、打开 fixture、生成调用图和卸载；发布产物由 tag 自动构建。

### M5：Phase 2 能力（P2）

只有 M0–M4 达标后再评估：

- 类/类型关系与 import 模块图；
- 变量级数据流与跨语言调用；
- 更多语言 grammar；
- 可分享的图快照和项目分析报告。

这些能力会显著改变索引模型，不应与缓存/会话协议并行设计。

## 4. 推荐实施顺序

```text
M0 扫描边界
  → M0 会话/请求协议
  → M0 解析歧义
  → M0 安全边界
  → M1 测试与 CI
  → M2 缓存/增量/性能
  → M3 产品闭环
  → M4 跨平台发布
  → M5 新分析能力
```

建议每个小项独立 PR，避免把协议重构、缓存和 UI 功能混在一次提交中。每个 PR 至少包含：

- 问题与边界说明；
- 对应自动化测试；
- `npm run verify` 结果；
- 涉及用户行为时的截图或短录屏；
- 若改变解析结果，附 fixture 前后差异。

## 5. 下一批可直接创建的任务

| 顺序 | 任务 | 主要文件 | 完成信号 |
| --- | --- | --- | --- |
| 1 | 拆分可查看/可解析扩展名，并补齐 skip 进度 | `App.tsx`、`main.ts`、Worker 协议 | 混合 fixture 进度 100% |
| 2 | 增加 `projectSessionId/requestId` 与取消语义 | `models.ts`、`useAnalyzer.ts`、`analyzer.worker.ts` | 快速切项目无串数据 |
| 3 | 未绑定调用返回歧义结果，不再取首候选 | `resolver.ts`、Worker、详情面板 | 同名 fixture 无误连 |
| 4 | IPC 路径约束与安全协议 | `main.ts`、`preload.ts`、Vite/Electron 配置 | 穿越测试失败、wasm 正常 |
| 5 | 迁移到 Vitest 并补真实 Electron 冒烟 | `package.json`、`tests/` | CI 可重复运行 |
| 6 | 实现解析缓存与单文件增量重扫 | 主进程缓存模块、Worker 协议 | 二次打开零重解析 |

完成前四项后，主线才适合进入功能扩展；完成前六项后，才适合对外发布测试版。

## 6. 文档维护规则

- 本文件记录优先级、依赖和验收标准；完成事项移动到 CHANGELOG，不在这里长期保留勾选清单。
- `docs/superpowers/specs/2026-08-20-callchain-electron-redesign-design.md` 是历史设计基线；
  当实现与其冲突时，以经过评审的新 ADR 和本路线图为准。
- 新的跨进程协议、缓存 schema、安全例外或解析语义必须在 `docs/adr/` 增加决策记录。
