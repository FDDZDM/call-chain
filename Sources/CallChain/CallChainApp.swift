// CallChainApp.swift —— App 入口与系统事件
// - ⌘O 打开项目目录（文件夹）
// - Finder 里把文件夹拖到 Dock 图标 / `open -a CallChain 目录` 也能打开

import SwiftUI
import AppKit

/// App 主体（无 @main，由 main.swift 调用 .main() 启动）
struct CallChainApp: App {
    /// NSApplication 委托：接收系统传入的目录打开事件
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    /// 全局项目状态（扫描、解析、查询、选中）
    @StateObject private var store = ProjectStore()

    var body: some Scene {
        WindowGroup {
            ContentView(store: store)
                .frame(minWidth: 860, minHeight: 560)
                .onAppear {
                    // ① 启动早期系统排队的目录（Finder 拖拽 / open 命令）
                    for url in appDelegate.pendingURLs { store.load(url: url) }
                    appDelegate.pendingURLs.removeAll()
                    // ② 命令行参数目录（`CallChain /path/to/proj`）
                    if let p = CommandLine.arguments.dropFirst()
                        .first(where: { !$0.hasPrefix("-") }) {
                        store.load(path: p)
                    }
                }
        }
        .defaultSize(width: 1280, height: 820)
        .commands {
            // 「新建文档」对这个工具无意义，移除 ⌘N
            CommandGroup(replacing: .newItem) {}
            // 打开项目目录
            CommandGroup(after: .newItem) {
                Button("打开项目…") { openFolderPanel() }
                    .keyboardShortcut("o", modifiers: .command)
                Button("重新扫描") { store.rescan() }
                    .keyboardShortcut("r", modifiers: .command)
                    .disabled(store.rootURL == nil)
            }
        }
    }

    /// 打开目录选择面板
    private func openFolderPanel() {
        let panel = NSOpenPanel()
        panel.title = "选择要分析的项目目录"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            store.load(url: url)
        }
    }
}

/// AppDelegate：接收系统级打开事件（启动早期排队，运行期转发）
final class AppDelegate: NSObject, NSApplicationDelegate {
    /// 启动早期 UI 未就绪时积压的目录
    var pendingURLs: [URL] = []

    func application(_ application: NSApplication, open urls: [URL]) {
        pendingURLs.append(contentsOf: urls)
        NotificationCenter.default.post(name: .openDirectoryRequest, object: urls)
    }
}

extension Notification.Name {
    /// 自定义通知：系统请求打开目录
    static let openDirectoryRequest = Notification.Name("CallChain.openDirectory")
}