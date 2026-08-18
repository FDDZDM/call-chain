// swift-tools-version:5.9
// CallChain —— 轻量代码调用链查看器（macOS 原生 SwiftUI，无第三方依赖）
// 功能：全局/局部查询语句或函数 → 绘制调用链图（上层=调用者，下层=被调用者）
// 形态：SPM 可执行 target，`swift build` 出二进制，Scripts/build_app.sh 打包 .app

import PackageDescription

let package = Package(
    name: "CallChain",
    platforms: [
        .macOS(.v14)   // 需要 macOS 14+（NavigationSplitView、ImageRenderer 等 API）
    ],
    targets: [
        .executableTarget(
            name: "CallChain"
        ),
        // 解析/构图逻辑单元测试（`swift test` 运行，swift-testing 框架）
        .testTarget(
            name: "CallChainTests",
            dependencies: ["CallChain"]
        ),
    ]
)