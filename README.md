# CallChain · 代码调用链查看器（macOS 原生 SwiftUI）

轻量实用的代码调用链分析工具：打开任意项目目录，**全局或局部查询某个函数/语句**，
自动解析调用关系并**绘制调用链图**——上层是调用者，中间是查询目标，下层是被调用者。

## 特性

- **多语言**：Kotlin / Java / Swift / TypeScript / JavaScript / C/C++ / Python / Go / ObjC，
  纯正则解析，零第三方依赖，离线可用
- **语句级查询**：全文命中后保留准确语句与行号，以其所属函数为锚点展开上下游，
  并在图中加粗该语句实际产生的调用边
- **函数作用说明**：优先展示源码注释；缺少注释时，根据函数名、实现范围与关键调用
  给出明确标注的离线推断，所有依据都可直接核对
- **全局 / 局部查询**：全局=整个项目，局部=当前选中的文件
- **调用链图**：Canvas 原生绘制，拖拽平移、双指缩放、单击选中、双击以节点为中心重建、
  空白双击复位；调用者/被调用者深度可调（1–5 层），也可一键展开完整可达链路
- **详情检查器**：选中节点后列出它调用了谁、谁调用了它（带全部调用点），点击调用点
  查看源码上下文（高亮行），一键用 Xcode（xed）定位打开
- **导出 PNG**：按图包围盒高清导出
- **CLI 模式**：`--analyze` 输出文本/JSON 调用链，适合脚本与自动化

## 构建与运行

```bash
# 开发
swift run

# 单元测试（swift-testing）
swift test

# 打包成 .app 并安装
./Scripts/build_app.sh
cp -R dist/CallChain.app ~/Applications/
open ~/Applications/CallChain.app

# 一键验证（build + test + CLI + 打包 + 启动冒烟）
./Scripts/verify.sh
```

## CLI 用法

```bash
.build/release/CallChain --analyze ~/Projects/coros_app \
    --symbol saveSession --callers 2 --callees 2
.build/release/CallChain --analyze ~/Projects/coros_app --symbol saveSession --full
.build/release/CallChain --analyze ~/Projects/coros_app --symbol ExploreStore --json
.build/release/CallChain --analyze <目录> --symbol <名称> --exclude build,node_modules --maxfiles 3000
```

## 架构

```
Sources/CallChain/
├── main.swift              # 入口：CLI 模式与 GUI 模式分流
├── CallChainApp.swift      # App 主体 + 系统打开事件
├── Models.swift            # SourceFile / Definition / CallSite / SearchHit
├── FileScanner.swift       # 目录扫描（排除构建目录、大小/数量上限）
├── AnalysisSession.swift   # 扫描+解析管线（CLI 与 GUI 共用）
├── AnalyzerPatterns.swift  # 各语言声明正则表 + 关键字黑名单
├── AnalyzerCore.swift      # 逐行解析主流程（括号/缩进作用域跟踪）
├── AnalyzerStrings.swift   # 注释/字符串剥离、括号计数工具
├── CallGraph.swift         # 图构建：名称解析 + 双向 BFS 分层
├── GraphLayout.swift       # 分层布局（世界坐标）
├── GraphRenderer.swift     # Canvas 绘制 + PNG 快照视图
├── GraphCanvasView.swift   # 交互画布（手势/命中/适配）
├── ProjectStore.swift      # 全局状态（@MainActor）
├── ContentView.swift       # 侧栏 + 主区 + 检查器
└── CLI.swift               # 命令行模式
```

**解析管线**：`SourceFile → Analyzer（声明识别 + 调用点归属）→ 名字索引 →
双向 BFS（调用者向上 / 被调用者向下）→ 分层布局 → Canvas 渲染`

## 已知限制（轻量正则策略的取舍）

- **按名字解析**：同名函数（重载、不同实现）无法区分，会全部连接（上限 3 个）；
  解析不到的调用记录为「未解析调用」可在详情面板查看
- **无括号调用不识别**：尾随闭包 `foo { }`、Swift 反引号模板、Python 装饰器链等
- 单行多个声明只取第一个；跨行参数列表的表达式体函数范围略宽松
- 三引号字符串/模板字符串按块处理，其中包含的括号不会计入作用域
- 声明匹配只在 ≤500 字符的行上执行（防正则在大压缩行上灾难性回溯；
  声明语句不会超长，且超长行大多是生成/压缩代码）
- 大仓库默认最多扫描 4000 个文件（`--maxfiles` 可调），单文件上限 2.5MB，
  扫描阶段 15 秒硬超时（防止巨型构建缓存拖垮工具）；跳过 hidden/构建/依赖目录

若要精确解析（语法树级别），可后续接入 tree-sitter 作为可选后端。
# call-chain
# call-chain
