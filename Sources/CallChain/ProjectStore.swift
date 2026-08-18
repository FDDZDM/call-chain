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

    private var fileIndex: [String: SourceFile] = [:]   // relPath → 文件（含行）
    private var defsByFile: [String: [Definition]] = [:] // relPath → 定义
    private var searchTask: Task<Void, Never>?

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
        self.currentFile = session.files.first?.relPath
        self.anchor = nil
        self.graph = nil
        self.selectedNodeID = nil
        self.results = []
        self.previewLines = []
        isLoading = false
        if session.files.isEmpty {
            errorMessage = "目录里没有可识别的源码文件（.kt/.java/.swift/.ts/.js/.c/.cpp/.py/.go/.m 等）"
        }
    }

    // MARK: 搜索

    /// 查询变化 → 防抖后执行搜索
    func scheduleSearch() {
        searchTask?.cancel()
        searchTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 80_000_000)
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.runSearch() }
        }
    }

    private func runSearch() {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { results = []; return }
        var hits: [SearchHit] = []
        var hitKeys = Set<String>()
        let scopeFiles = scope == .project ? files
            : files.filter { $0.relPath == currentFile }

        func add(_ hit: SearchHit) {
            guard hits.count < 300 else { return }
            if hitKeys.insert(hit.id).inserted { hits.append(hit) }
        }

        for f in scopeFiles {
            let defs = defsByFile[f.relPath] ?? []
            for d in defs {
                // 定义名命中
                if d.name.range(of: q, options: .caseInsensitive) != nil {
                    add(SearchHit(kind: .definition, definition: d,
                                  line: d.line, code: d.signature))
                }
                // 定义范围内行文本命中（签名 + 调用行 + 函数体行）
                if d.signature.range(of: q, options: .caseInsensitive) != nil
                    && d.name.range(of: q, options: .caseInsensitive) == nil {
                    add(SearchHit(kind: .text, definition: d, line: d.line, code: d.signature))
                }
                for site in d.calls where site.code.range(of: q, options: .caseInsensitive) != nil {
                    add(SearchHit(kind: .text, definition: d, line: site.line, code: site.code))
                }
                for (idx, line) in f.lines.enumerated()
                where line.range(of: q, options: .caseInsensitive) != nil {
                    let n = idx + 1
                    // 避开上面已加过的行
                    if n == d.line { continue }
                    if d.calls.contains(where: { $0.line == n }) { continue }
                    if n >= d.line && n <= (d.endLine > 0 ? d.endLine : d.line) {
                        add(SearchHit(kind: .text, definition: d, line: n, code: line))
                    }
                }
            }
        }
        results = hits
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