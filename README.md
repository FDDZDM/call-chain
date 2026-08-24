# CallChain · 代码调用链查看器

轻量实用的代码调用链分析工具：打开任意项目目录，**⌘+点击代码中的函数名**，
自动解析调用关系并**绘制调用链图**——左侧是调用者，中间是查询目标，右侧是被调用者。

当前主线为 **Electron 跨平台版本**（`electron/`，tree-sitter 语法级解析，深色主题界面）；
早期 macOS 原生 SwiftUI 版本（`Sources/`）保留在仓库中，详见文末。

## 特性

- **语法级解析**：基于 tree-sitter（wasm）语法树提取函数符号与调用点，
  支持 TypeScript / JavaScript / Python / Java / Kotlin
- **⌘+点击即用**：Monaco 只读查看器中按住 ⌘（Windows 为 Ctrl）悬停函数名出现蓝色下划线，
  点击即可生成调用链
- **符合源码阅读顺序**：调用者 → 当前函数 → 被调用者始终由左向右，
  同层被调用者按调用点在源码中的出现顺序稳定排列
- **渐进式调用链图**：SVG 分层布局，初始展示锚点+1 层，点击节点逐层展开；
  悬停高亮锚点到该节点的完整路径（路径追光）；内置 Minimap 导航与面包屑定位
- **信息完整优先**：分析层保留共享下游和所有真实函数；只有可见节点超过 30 时，
  视图才临时把工具函数折叠为聚合簇，点击簇可展开
- **长名称友好**：类名/函数名优先在点号、下划线和驼峰边界换行，路径压缩显示，
  节点内容不再越界，完整签名和路径可在悬浮详情中查看
- **节点详情面板**：展示函数职责（源码注释）、调用上下文（调用点位置、源码片段、调用次数），
  支持一键重新锚定
- **多标签代码查看器**：Monaco 深色主题、按类型着色的文件图标、最多 8 个标签、视图状态保持
- **项目树**：目录/文件 SVG 图标（按扩展名着色），⌘\ 快速开关
- **解析进度反馈**：顶部进度条实时显示已解析文件数与已提取函数数
- **编码兼容**：UTF-8 → GBK → Shift-JIS 自动降级解码，BOM 剥离与二进制检测
- **零原生依赖**：tree-sitter 使用 wasm 版本，Windows / macOS 跨平台打包无额外负担

## 快速开始（Electron 版）

```bash
cd electron
npm install

# 开发模式（Vite + Electron，主进程自动探测 dev server 端口）
npm run dev

# 打包 .app（产物：release/mac-arm64/CallChain.app）
npm run electron:build
```

> 打包默认不签名，首次打开如被 Gatekeeper 拦截：右键 → 打开。
> 补充 ad-hoc 签名：`codesign --force --deep -s - release/mac-arm64/CallChain.app`

## 交互速查

| 操作 | 说明 |
| --- | --- |
| ⌘O | 打开项目目录 |
| ⌘\ | 显示 / 隐藏项目树 |
| ⌘+点击函数名 | 生成该函数的调用链 |
| 点击图节点 | 选中并展开 / 折叠下一层 |
| 点击工具聚合簇 | 展开簇内的真实函数 |
| 双击图节点 | 超过节点上限时强制展开 |
| 滚轮 / 拖拽 / 双击空白 | 缩放 / 平移 / 适配视图 |
| Esc | 退出调用图全屏 |

## 架构

```
electron/
├── electron/
│   ├── main.ts             # 主进程：窗口、IPC（目录扫描/文件读取/对话框）
│   └── preload.ts          # contextBridge 暴露受控 API
├── src/
│   ├── App.tsx             # 根组件：三栏布局（项目树｜代码｜调用图+详情）
│   ├── index.css           # 全局深色主题（紫色品牌色 CSS 变量）
│   ├── components/
│   │   ├── ProjectTree.tsx     # 项目树侧边栏
│   │   ├── CodeViewer.tsx      # Monaco 只读多标签查看器
│   │   └── CallGraphView.tsx   # SVG 调用链交互图
│   ├── analyzer/
│   │   ├── analyzer.worker.ts  # Web Worker：消息队列串行处理解析请求
│   │   ├── parser.ts           # tree-sitter 符号/调用点提取
│   │   ├── queries.ts          # 各语言 tree-sitter 查询
│   │   ├── resolver.ts         # 符号解析
│   │   └── graphBuilder.ts     # 方向 BFS 建图
│   ├── graph/
│   │   ├── layout.ts           # 稳定分层布局与连线几何
│   │   └── labels.ts           # 函数限定名换行与路径压缩
│   ├── hooks/useAnalyzer.ts    # Worker 通信封装
│   ├── monaco/setup.ts         # Monaco worker 与语言配置
│   └── types/                  # 共享类型定义
└── vite.config.mts             # Vite + Electron 一体化构建（唯一 ESM 配置源）
```

**三进程架构**：主进程只负责 IO（目录扫描、文件读取、对话框）；渲染进程只做 UI
（React + Monaco + SVG）；解析与建图全部在 Web Worker 中执行，不阻塞界面。

**函数符号 ID**：`lang::filePath::className::name::paramTypeSignature`，重载函数可区分。

**调用链语义**：以锚点为中心做方向 BFS——锚点同时展示调用者与被调用者；
调用者节点只继续向左展开其调用者，被调用者节点只继续向右展开其被调用者。
BFS 首次发现路径仅用于面包屑；可展开邻居从完整有向边重建，因此菱形 DAG 的共享下游不会丢失。

## 验证

```bash
cd electron
npm ci
npm run verify   # TypeScript 类型检查 + Vite/Electron 构建 + 解析/链路/呈现测试

cd ..
swift test       # 早期 SwiftUI 版的 26 项回归测试
```

链路图回归测试覆盖：上下游方向、源码调用顺序、菱形 DAG 共享节点、
不提前聚合、长限定名换行、长路径截断和左—中—右分层坐标。

## Swift 原生版（macOS，早期版本）

仓库根目录为早期 SwiftUI 实现，纯正则解析、零第三方依赖：

```bash
swift run                # 开发
swift test               # 单元测试（swift-testing）
./Scripts/build_app.sh   # 打包 dist/CallChain.app
./Scripts/verify.sh      # 一键验证（build + test + CLI + 打包 + 冒烟）
```

特色功能：语句级全文查询、函数作用离线推断、CLI 模式
（`--analyze <目录> --symbol <名称> --callers 2 --callees 2`）、PNG 导出。

其解析策略为逐行正则 + 括号/缩进作用域跟踪，存在已知取舍：同名函数无法区分、
尾随闭包等无括号调用不识别、大仓库扫描上限 4000 文件——
这些问题在 Electron 版中已由 tree-sitter 语法级解析解决。

## 已知限制（Electron 版）

- 语言覆盖：当前内置 5 种语言（TS / JS / Python / Java / Kotlin）的 tree-sitter 语法；
  Kotlin 查询已覆盖直接调用与成员/安全调用（`obj.foo()` / `obj?.foo()`）
- 调用图可见节点上限 30（防布局爆炸），超限自动聚合工具函数，双击节点可强制展开
- 代码查看器为只读设计，不支持编辑保存
