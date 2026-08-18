// main.swift —— 程序入口（顶层代码）
// 两种运行形态：
//   1) 命令行模式：`CallChain --analyze <目录> [--symbol 名称] ...`
//      无界面，把分析结果（调用链）打印到 stdout，便于脚本/自动化验证。
//   2) GUI 模式：正常启动 SwiftUI App，打开项目目录后交互式查看调用链。

import SwiftUI

// 只要命令行里带 --analyze，就走 CLI 模式（不启动窗口）
if CommandLine.arguments.contains("--analyze") {
    exit(CLI.run(arguments: CommandLine.arguments))
} else {
    // 启动 SwiftUI App（等价于 @main 的作用）
    CallChainApp.main()
}