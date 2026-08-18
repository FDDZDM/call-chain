// ProjectStore.swift —— 全局状态（扫描、解析、搜索、选中、预览）
// @MainActor：所有 UI 状态都在主线程更新；扫描/解析同步执行但设 isLoading 标志。

import SwiftUI
import AppKit

@MainActor
final class ProjectStore: ObservableObject {

    enum Scope: String, CaseIterable, Identifiable {
        case project = "全局搜索"
        case file = "当前文件"
        var id: String { rawValue }
    }

    // MARK: 状态

    @Published var rootURL: URL?
    @Published var files: [SourceFile] = []
    @Published var allDefs: [Definition] = []
    @Published var isLoading = false
    @Published var errorMessage: String?

    @Published var query = ""
    @Published var scope: Scope = .project
    @Published var currentFile: String?          // 相对路径
    @Published var results: [SearchHit] = []
    @Published var searchTruncated = false        // 搜索因行数预算提前截断
    @Published var searchInfo = ""                // 状态栏提示（耗时/行数）

    @Published var anchor: Definition?
    @Published var graph: CallGraph?
    @Published var selectedNodeID: String?
    @Published var callerDepth = 2
    @Published var callDepth = 2
    @Published var fitRequestID = 0              // 递增即触发画布重新适配

    @Published var previewFilePath: String?
    @Published var previewStartLine = 0
    @Published var previewLines: [String] = []
    @Published var previewHighlightLine = 0

    // MARK: 内部索引

    private var fileIndex: [String: SourceFile] = [:]    // relPath → 文件（含行）
    private var defsByFile: [String: [Definition]] = [:] // relPath → 定义
    private var lineOwners: [String: [Int]] = [:]        // relPath → 每行归属定义索引
    private var searchTask: Task<Void, Never>?

    /// 目录树展开状态（路径用 / 连接）
    @Published var expandedDirs: Set<String> = []

    func toggleDir(_ path: String) {
        if expandedDirs.contains(path) { expandedDirs.remove(path) }
        else { expandedDirs.insert(path) }
    }

    /// 目录树（按 relPath 聚合，目录在前、文件在后，字母序）
    struct TreeNode: Identifiable {
        enum Kind { case directory(name: String, path: String, children: [TreeNode])
                    case file(relPath: String) }
        let kind: Kind
        var id: String {
            switch kind {
            case .directory(_, let path, _): return "d:\(path)"
            case .file(let relPath):         return "f:\(relPath)"
            }
        }
    }

    func buildTree() -> [TreeNode] {
        var root: [String: (dirs: [String: [String]], files: [String])] = [:]
        // 收集：目录路径 → 子目录名列表 + 文件相对路径列表
        func ensureDir(_ dirPath: String) {
            if root[dirPath] == nil { root[dirPath] = ([:], []) }
        }
        ensureDir("")
        for f in files {
            let comps = f.relPath.split(separator: "/").map(String.init)
            var dirPath = ""
            for i in 0..<(comps.count - 1) {
                let parent = dirPath
                dirPath = dirPath.isEmpty ? comps[i] : dirPath + "/" + comps[i]
                ensureDir(parent)
                if root[parent]?.dirs[comps[i]] == nil {
                    root[parent]?.dirs[comps[i]] = []
                }
                ensureDir(dirPath)
            }
            root[dirPath]?.files.append(f.relPath)
        }
        func node(dirPath: String) -> [TreeNode] {
            guard let entry = root[dirPath] else { return [] }
            var nodes: [TreeNode] = []
            for (name, _) in entry.dirs.sorted(by: { $0.key < $1.key }) {
                let childPath = dirPath.isEmpty ? name : dirPath + "/" + name
                nodes.append(.init(kind: .directory(name: name, path: childPath,
                                                    children: node(dirPath: childPath))))
            }
            for rel in entry.files.sorted() {
                nodes.append(.init(kind: .file(relPath: rel)))
            }
            return nodes
        }
        return node(dirPath: "")
    }

    /// 绝对路径（详情面板/编辑器打开用）
    func absPath(_ relPath: String) -> String? {
        guard let root = rootURL?.path else { return nil }
        return root + "/" + relPath
    }

    // MARK: 加载目录

    func load(url: URL) {
        rootURL = url
        rescan()
    }

    func load(path: String) {
        load(url: URL(fileURLWithPath: path))
    }

    func rescan() {
        guard let root = rootURL else { return }
        isLoading = true
        errorMessage = nil
        // 同步扫描+解析（几千文件的仓库也就一两秒；扫描完立即可用）
        let session = AnalysisSession.run(url: root, options: ScanOptions())
        self.files = session.files
        self.allDefs = session.defs
        self.defsByFile = session.defsByFile
        self.fileIndex = session.fileIndex
        // 预建「行→定义」索引（搜索归属 O(1) 的关键）
        var owners: [String: [Int]] = [:]
        for file in session.files {
            owners[file.relPath] = SearchEngine.buildLineOwners(
                file: file, defs: session.defsByFile[file.relPath] ?? [])
        }
        self.lineOwners = owners
        self.expandedDirs = []
        self.currentFile = session.files.first?.relPath
        self.anchor = nil
        self.graph = nil
        self.selectedNodeID = nil
        self.results = []
        self.searchTruncated = false
        self.searchInfo = ""
        self.previewLines = []
        isLoading = false
        if session.files.isEmpty {
            errorMessage = "目录里没有可识别的源码文件（.kt/.java/.swift/.ts/.js/.c/.cpp/.py/.go/.m 等）"
        }
    }

    // MARK: 搜索

    /// 查询变化 → 防抖后在后台线程搜索（不阻塞 UI）
    func scheduleSearch() {
        searchTask?.cancel()
        // 快照当前输入（后台任务使用不可变副本，避免与 UI 状态竞争）
        let queryNow = query
        let scopeNow = scope
        let fileNow = currentFile
        let filesNow = files
        let defsNow = defsByFile
        let ownersNow = lineOwners

        searchTask = Task {
            try? await Task.sleep(nanoseconds: 80_000_000)
            guard !Task.isCancelled else { return }
            let t0 = Date()
            // SearchEngine 是纯函数：在后台线程执行
            let res = await Task.detached(priority: .userInitiated) {
                SearchEngine.search(files: filesNow,
                                    defsByFile: defsNow,
                                    lineOwners: ownersNow,
                                    query: queryNow,
                                    scopeProject: scopeNow == .project,
                                    currentFile: fileNow)
            }.value
            guard !Task.isCancelled else { return }
            let ms = Int(Date().timeIntervalSince(t0) * 1000)
            // 只把结果交回主线程，避免整段搜索阻塞 UI
            await MainActor.run { [weak self] in
                guard let self, self.query == queryNow else { return }
                self.results = res.hits
                self.searchTruncated = res.truncated
                self.searchInfo = String(format: "%d 命中 · 扫 %.1f 万行 · %d ms",
                                         res.hits.count,
                                         Double(res.scannedLines) / 10_000,
                                         ms)
            }
        }
    }

    // MARK: 锚点与构图

    /// 把某个定义设为锚点并重建调用链图
    func anchorDefinition(_ def: Definition) {
        anchor = def
        selectedNodeID = def.id
        rebuildGraph()
    }

    func rebuildGraph() {
        guard let anchor else { graph = nil; return }
        var g = GraphBuilder.build(allDefs: allDefs, target: anchor,
                                   callDepth: callDepth, callerDepth: callerDepth)
        GraphLayout.layout(&g)
        graph = g
        selectedNodeID = anchor.id
        showSnippet(file: anchor.file, line: anchor.line)
    }

    /// 点击文件的处理：设为当前文件，并默认锚到它的第一个定义
    func selectFile(_ relPath: String) {
        currentFile = relPath
        if anchor == nil || anchor?.file != relPath {
            let defs = defsByFile[relPath] ?? []
            if let first = defs.first {
                anchorDefinition(first)
            }
        }
    }

    // MARK: 选中/预览

    func selectNode(id: String) {
        selectedNodeID = id
        if let node = node(id: id) {
            showSnippet(file: node.def.file, line: node.def.line)
        }
    }

    func node(id: String) -> GraphNode? {
        graph?.nodes.first { $0.id == id }
    }

    /// 显示某文件某行附近的源码片段（预览面板）
    func showSnippet(file: String, line: Int) {
        guard let sf = fileIndex[file], !sf.lines.isEmpty else {
            previewFilePath = nil; previewLines = []; return
        }
        let lo = max(1, line - 10)
        let hi = min(sf.lines.count, line + 10)
        previewFilePath = file
        previewStartLine = lo
        previewLines = Array(sf.lines[(lo - 1)..<hi])
        previewHighlightLine = line
    }

    /// 在默认编辑器中打开文件（优先 Xcode 的 xed 定位行，否则系统默认打开）
    func openInEditor(relPath: String, line: Int? = nil) {
        guard let abs = absPath(relPath) else { return }
        let url = URL(fileURLWithPath: abs)
        let xedPath = "/usr/bin/xed"
        if let line, FileManager.default.isExecutableFile(atPath: xedPath) {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: xedPath)
            p.arguments = ["--line", "\(line)", url.path]
            try? p.run()
            return
        }
        NSWorkspace.shared.open(url)
    }
}