// ContentView.swift —— 主界面
// 三栏布局（NavigationSplitView 骨架 + HSplitView）：
//   侧栏：搜索范围选择 + 搜索框 + 查询结果 + 文件列表
//   主区：调用链画布
//   检查器：选中节点详情 + 调用点列表 + 源码片段预览

import SwiftUI
import AppKit

// MARK: - 主布局

struct ContentView: View {
    @ObservedObject var store: ProjectStore

    var body: some View {
        Group {
            if store.rootURL == nil {
                welcomeView
            } else {
                NavigationSplitView {
                    sidebar
                        .navigationSplitViewColumnWidth(min: 250, ideal: 290)
                } detail: {
                    DetailView(store: store)
                }
            }
        }
        .environmentObject(store)
        .onReceive(NotificationCenter.default.publisher(for: .openDirectoryRequest)) { note in
            if let urls = note.object as? [URL], let first = urls.first {
                store.load(url: first)
            }
        }
        .alert("提示", isPresented: Binding(
            get: { store.errorMessage != nil },
            set: { if !$0 { store.errorMessage = nil } }
        )) {
            Button("好", role: .cancel) {}
        } message: {
            Text(store.errorMessage ?? "")
        }
    }

    private var welcomeView: some View {
        VStack(spacing: 14) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .font(.system(size: 56)).foregroundColor(.accentColor)
            Text("CallChain · 代码调用链查看器")
                .font(.title2.bold())
            Text("⌘O 打开一个项目目录，然后搜索函数或语句查看调用链")
                .foregroundColor(.secondary)
            Button("打开项目…") { openPanel() }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut("o", modifiers: .command)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func openPanel() {
        let panel = NSOpenPanel()
        panel.title = "选择要分析的项目目录"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            store.load(url: url)
        }
    }

    // MARK: 侧栏

    private var sidebar: some View {
        VStack(spacing: 0) {
            // 搜索范围
            Picker("范围", selection: $store.scope) {
                ForEach(ProjectStore.Scope.allCases) { s in
                    Text(s.rawValue).tag(s)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 10)
            .padding(.top, 10)

            // 搜索框
            TextField("搜索函数 / 语句…", text: $store.query)
                .textFieldStyle(.roundedBorder)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .onChange(of: store.query) { store.scheduleSearch() }

            // 结果 + 文件树
            List {
                if !store.results.isEmpty {
                    Section("查询结果 · \(store.results.count)") {
                        ForEach(store.results) { hit in
                            resultRow(hit)
                        }
                    }
                }
                Section("项目结构 · \(store.files.count) 文件") {
                    FileTreeView(nodes: store.buildTree(),
                                 expanded: $store.expandedDirs)
                }
            }
            .listStyle(.sidebar)

            // 状态栏
            HStack {
                if store.isLoading {
                    ProgressView().controlSize(.small)
                    Text("扫描中…").font(.caption).foregroundColor(.secondary)
                } else {
                    Text(fileCountText)
                        .font(.caption).foregroundColor(.secondary)
                        .lineLimit(1)
                    if store.searchTruncated {
                        Text("⚠ 搜索超出行数上限已截断")
                            .font(.caption).foregroundColor(.orange)
                            .lineLimit(1)
                    }
                }
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
    }

    private var fileCountText: String {
        if store.query.trimmingCharacters(in: .whitespaces).isEmpty {
            return "\(store.files.count) 文件 · \(store.allDefs.count) 定义"
        }
        return store.searchInfo
    }

    private func resultRow(_ hit: SearchHit) -> some View {
        Button {
            store.anchorSearchHit(hit)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: hit.kind == .definition
                      ? hit.definition.kind.icon : "text.alignleft")
                    .font(.system(size: 11))
                    .foregroundColor(.accentColor)
                    .frame(width: 16)
                VStack(alignment: .leading, spacing: 1) {
                    Text(hit.kind == .definition
                         ? hit.definition.name
                         : hit.code.trimmingCharacters(in: .whitespaces))
                        .font(.system(size: 12, weight: .medium))
                        .lineLimit(1)
                    Text(hit.kind == .definition
                         ? "\(hit.definition.file):\(hit.line)"
                         : "位于 \(hit.definition.name) · \(hit.definition.file):\(hit.line)")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button(hit.kind == .definition ? "以它为中心" : "查看这条语句的调用链") {
                store.anchorSearchHit(hit)
            }
            Button("在编辑器中打开") {
                store.openInEditor(relPath: hit.definition.file, line: hit.line)
            }
        }
    }
}

// MARK: - 项目目录树（递归视图）

struct FileTreeView: View {
    let nodes: [ProjectStore.TreeNode]
    @Binding var expanded: Set<String>

    var body: some View {
        ForEach(nodes) { node in
            switch node.kind {
            case .directory(_, let path, let children):
                DisclosureGroup(isExpanded: binding(for: path)) {
                    FileTreeView(nodes: children, expanded: $expanded)
                        .padding(.leading, 6)
                } label: {
                    Label((path as NSString).lastPathComponent,
                          systemImage: "folder")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                }
            case .file(let relPath):
                FileTreeRow(relPath: relPath)
            }
        }
    }

    private func binding(for path: String) -> Binding<Bool> {
        Binding(
            get: { expanded.contains(path) },
            set: { on in
                if on { expanded.insert(path) } else { expanded.remove(path) }
            }
        )
    }
}

/// 树里的文件行（需要访问 store，单独抽成视图）
struct FileTreeRow: View {
    let relPath: String
    @EnvironmentObject private var store: ProjectStore

    var body: some View {
        Button {
            store.selectFile(relPath)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "doc.text")
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
                    .frame(width: 14)
                Text((relPath as NSString).lastPathComponent)
                    .font(.system(size: 12))
                    .lineLimit(1)
                    .foregroundColor(store.currentFile == relPath ? .primary : .secondary)
                Spacer(minLength: 4)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - 主区（画布 + 检查器）

struct DetailView: View {
    @ObservedObject var store: ProjectStore

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            HSplitView {
                GraphCanvasView(store: store)
                    .frame(minWidth: 400)
                InspectorView(store: store)
                    .frame(minWidth: 300, idealWidth: 340, maxWidth: 420)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onChange(of: store.callerDepth) {
            if !store.showsFullChain { store.rebuildGraph() }
        }
        .onChange(of: store.callDepth) {
            if !store.showsFullChain { store.rebuildGraph() }
        }
        .onChange(of: store.showsFullChain) { store.rebuildGraph() }
    }

    private var header: some View {
        HStack(spacing: 12) {
            if let anchor = store.anchor {
                Image(systemName: anchor.kind.icon)
                    .foregroundColor(.accentColor)
                Text(anchor.name).font(.headline).lineLimit(1)
                Text("\(anchor.file):\(anchor.line)")
                    .font(.caption).foregroundColor(.secondary)
                Text("锚点")
                    .font(.caption2)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Color.accentColor.opacity(0.15),
                                in: Capsule())
                if let focus = store.focusedStatement {
                    Label("语句 · L\(focus.line)", systemImage: "scope")
                        .font(.caption2)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color.accentColor.opacity(0.15), in: Capsule())
                }
            } else {
                Text("未选择目标").foregroundColor(.secondary)
            }
            Spacer()

            // 深度控制
            depthControl(label: "上层", value: $store.callerDepth)
                .disabled(store.showsFullChain)
            depthControl(label: "下层", value: $store.callDepth)
                .disabled(store.showsFullChain)

            Toggle("完整链", isOn: $store.showsFullChain)
                .toggleStyle(.switch)
                .controlSize(.small)
                .help("遍历全部可达的调用者与被调用者；超大调用图仍受安全上限保护")

            Button {
                store.fitRequestID += 1
            } label: {
                Label("适配视图", systemImage: "arrow.up.left.and.down.right.magnifyingglass")
            }
            .disabled(store.graph == nil)

            Button {
                exportPNG()
            } label: {
                Label("导出 PNG", systemImage: "square.and.arrow.up")
            }
            .disabled(store.graph == nil)

            if let graph = store.graph {
                Text("\(graph.nodes.count) 节点 · \(graph.edges.count) 边"
                     + (graph.unresolved.isEmpty ? "" : " · 未解析 \(graph.unresolved.count)")
                     + (graph.isTruncated ? " · 已达安全上限" : ""))
                    .font(.caption).foregroundColor(.secondary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private func depthControl(label: String, value: Binding<Int>) -> some View {
        HStack(spacing: 4) {
            Text(label).font(.caption).foregroundColor(.secondary)
            Button("-") { if value.wrappedValue > 1 { value.wrappedValue -= 1 } }
                .buttonStyle(.bordered).controlSize(.small)
            Text("\(value.wrappedValue)")
                .font(.caption.monospacedDigit())
                .frame(width: 14)
            Button("+") { if value.wrappedValue < 5 { value.wrappedValue += 1 } }
                .buttonStyle(.bordered).controlSize(.small)
        }
    }

    /// 导出 PNG（按图的包围盒渲染）
    private func exportPNG() {
        guard let graph = store.graph, !graph.nodes.isEmpty else { return }
        let size = CGSize(width: max(graph.bounds.width, 200),
                          height: max(graph.bounds.height, 120))
        let renderer = ImageRenderer(content: GraphSnapshotView(graph: graph)
            .frame(width: size.width, height: size.height))
        renderer.scale = 2
        guard let img = renderer.nsImage,
              let tiff = img.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { return }
        let panel = NSSavePanel()
        panel.title = "导出调用链图"
        panel.nameFieldStringValue = "\(store.anchor?.name ?? "callchain").png"
        panel.allowedContentTypes = [.png]
        if panel.runModal() == .OK, let url = panel.url {
            try? png.write(to: url)
        }
    }
}

// MARK: - 检查器（选中节点详情 + 调用点 + 源码预览）

struct InspectorView: View {
    @ObservedObject var store: ProjectStore

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if let focus = store.focusedStatement {
                        statementFocusCard(focus)
                        Divider()
                    }
                    if let node = selectedNode {
                        nodeHeader(node)
                        Divider()
                        functionInsightCard(node)
                        Divider()
                        callRelations(node)
                        Divider()
                        unresolvedSection
                    } else {
                        Text("单击图中的节点查看详情")
                            .foregroundColor(.secondary)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
                .padding(12)
            }
            Divider()
            snippetPreview
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var selectedNode: GraphNode? {
        guard let id = store.selectedNodeID else { return nil }
        return store.node(id: id)
    }

    // 当前全文搜索命中的具体语句
    private func statementFocusCard(_ focus: StatementFocus) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Label("当前语句", systemImage: "scope")
                    .font(.caption.bold())
                    .foregroundColor(.accentColor)
                Spacer()
                Text("\((focus.file as NSString).lastPathComponent):\(focus.line)")
                    .font(.caption.monospacedDigit())
                    .foregroundColor(.secondary)
            }
            Text(focus.code.trimmingCharacters(in: .whitespaces))
                .font(.system(size: 11, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(Color.accentColor.opacity(0.10),
                            in: RoundedRectangle(cornerRadius: 7))
            Text("调用图以它所属的函数为中心；该语句产生的调用边已加粗。")
                .font(.caption2)
                .foregroundColor(.secondary)
            HStack(spacing: 8) {
                Button("查看上下文") {
                    store.showSnippet(file: focus.file, line: focus.line)
                }
                Button("在编辑器中打开") {
                    store.openInEditor(relPath: focus.file, line: focus.line)
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
    }

    // 节点头部
    private func nodeHeader(_ node: GraphNode) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: node.def.kind.icon)
                    .foregroundColor(GraphRenderer.levelColor(node.level))
                Text(node.def.name)
                    .font(.title3.bold())
                    .lineLimit(2)
                Spacer()
            }
            Text(GraphRenderer.levelText(node.level))
                .font(.caption)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(GraphRenderer.levelColor(node.level).opacity(0.15),
                            in: Capsule())
            Text(node.def.file)
                .font(.caption).foregroundColor(.secondary).lineLimit(1)
            Text("第 \(node.def.line) 行")
                .font(.caption).foregroundColor(.secondary)
            HStack(spacing: 8) {
                Button("以它为中心") { store.anchorDefinition(node.def) }
                    .buttonStyle(.bordered).controlSize(.small)
                Button("打开文件") {
                    store.openInEditor(relPath: node.def.file, line: node.def.line)
                }
                .buttonStyle(.bordered).controlSize(.small)
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(node.def.name, forType: .string)
                } label: {
                    Image(systemName: "doc.on.doc")
                }
                .buttonStyle(.bordered).controlSize(.small)
                .help("复制名字")
            }
        }
    }

    // 函数作用：注释优先，缺失时显示可核验的离线推断
    private func functionInsightCard(_ node: GraphNode) -> some View {
        let insight = store.insight(for: node.def)
        return VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text("函数作用")
                    .font(.caption.bold())
                    .foregroundColor(.secondary)
                Spacer()
                Label(insight.basis.label, systemImage: insight.basis.icon)
                    .font(.caption2)
                    .foregroundColor(insight.basis == .sourceComment ? .green : .secondary)
            }
            Text(insight.summary)
                .font(.system(size: 13, weight: .medium))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(insight.facts, id: \.self) { fact in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Circle()
                        .fill(Color.secondary.opacity(0.55))
                        .frame(width: 4, height: 4)
                    Text(fact)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .textSelection(.enabled)
                }
            }
        }
        .padding(10)
        .background(Color.primary.opacity(0.045),
                    in: RoundedRectangle(cornerRadius: 9))
    }

    // 调用关系列表
    private func callRelations(_ node: GraphNode) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            // 它调用的（出边）
            Text("调用了 \(outEdges(node).count) 个 · \(siteSum(outEdges(node))) 处调用点")
                .font(.caption.bold()).foregroundColor(.secondary)
            if outEdges(node).isEmpty {
                Text("（无）").font(.caption).foregroundStyle(.tertiary)
            }
            ForEach(outEdges(node)) { edge in
                siteRow(system: "arrow.down", title: edge.toName(in: store),
                        sites: edge.sites)
            }
            Divider()
            // 调用它的（入边）
            Text("被 \(inEdges(node).count) 个调用 · \(siteSum(inEdges(node))) 处调用点")
                .font(.caption.bold()).foregroundColor(.secondary)
            if inEdges(node).isEmpty {
                Text("（无）").font(.caption).foregroundStyle(.tertiary)
            }
            ForEach(inEdges(node)) { edge in
                siteRow(system: "arrow.up", title: edge.fromName(in: store),
                        sites: edge.sites)
            }
        }
    }

    private func outEdges(_ node: GraphNode) -> [GraphEdge] {
        store.graph?.edges.filter { $0.from == node.id } ?? []
    }

    private func inEdges(_ node: GraphNode) -> [GraphEdge] {
        store.graph?.edges.filter { $0.to == node.id } ?? []
    }

    private func siteSum(_ edges: [GraphEdge]) -> Int {
        edges.reduce(0) { $0 + $1.sites.count }
    }

    private func siteRow(system: String, title: String,
                         sites: [CallSite]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Image(systemName: system).font(.system(size: 9))
                    .foregroundColor(.secondary)
                Text(title).font(.system(size: 12, weight: .medium))
                Text("× \(sites.count)").font(.caption)
                    .foregroundColor(.secondary)
            }
            ForEach(sites.prefix(6)) { site in
                Button {
                    store.showSnippet(file: site.file, line: site.line)
                } label: {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(site.shortLocation)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundColor(.secondary)
                        Text(site.code.trimmingCharacters(in: .whitespaces))
                            .font(.system(size: 10, design: .monospaced))
                            .lineLimit(1)
                            .foregroundColor(.primary)
                    }
                    .padding(.leading, 14)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            if sites.count > 6 {
                Text("还有 \(sites.count - 6) 处…")
                    .font(.caption2).foregroundColor(.secondary)
                    .padding(.leading, 14)
            }
        }
        .padding(.vertical, 2)
    }

    // 未解析调用
    @ViewBuilder private var unresolvedSection: some View {
        if let graph = store.graph, !graph.unresolved.isEmpty {
            Text("未解析调用（没有找到同名定义）· \(graph.unresolved.count)")
                .font(.caption.bold()).foregroundColor(.orange)
            ForEach(graph.unresolved.prefix(8)) { site in
                Button {
                    store.showSnippet(file: site.file, line: site.line)
                } label: {
                    Text("\(site.shortLocation)  \(site.code.trimmingCharacters(in: .whitespaces))")
                        .font(.system(size: 10, design: .monospaced))
                        .lineLimit(1)
                        .foregroundColor(.secondary)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    // 源码片段预览
    private var snippetPreview: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                if let f = store.previewFilePath {
                    Image(systemName: "chevron.left.forwardslash.chevron.right")
                        .font(.system(size: 10))
                    Text(f).font(.caption).foregroundColor(.secondary).lineLimit(1)
                    Spacer()
                    Button("在编辑器中打开") {
                        store.openInEditor(relPath: f, line: store.previewHighlightLine)
                    }
                    .buttonStyle(.link).controlSize(.small)
                } else {
                    Text("点击调用点查看源码上下文")
                        .font(.caption).foregroundStyle(.tertiary)
                }
            }
            ScrollView([.horizontal, .vertical]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(store.previewLines.indices, id: \.self) { i in
                        let lineNo = store.previewStartLine + i
                        let isHl = (lineNo == store.previewHighlightLine)
                        HStack(spacing: 0) {
                            Text(String(format: "%5d", lineNo))
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundColor(.secondary)
                                .frame(width: 44, alignment: .trailing)
                                .padding(.trailing, 8)
                            Text(store.previewLines[i])
                                .font(.system(size: 10.5, design: .monospaced))
                                .foregroundColor(isHl ? .primary : .secondary)
                                .textSelection(.enabled)
                            Spacer(minLength: 0)
                        }
                        .padding(.vertical, 0.5)
                        .background(isHl ? Color.accentColor.opacity(0.18) : .clear)
                    }
                }
                .padding(6)
            }
            .frame(minHeight: 90, maxHeight: 200)
            .background(Color.primary.opacity(0.04),
                        in: RoundedRectangle(cornerRadius: 6))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }
}

// MARK: - 边展示辅助

extension GraphEdge {
    /// 边另一端节点在图中显示的名字（@MainActor：访问 ProjectStore 需要）
    @MainActor
    func toName(in store: ProjectStore) -> String {
        if let n = store.node(id: to) { return n.def.name }
        return String(to.split(separator: "::").dropFirst().first ?? "?")
    }
    @MainActor
    func fromName(in store: ProjectStore) -> String {
        if let n = store.node(id: from) { return n.def.name }
        return String(from.split(separator: "::").dropFirst().first ?? "?")
    }
}

extension GraphRenderer {
    /// 层级说明文字
    static func levelText(_ level: Int) -> String {
        if level == 0 { return "查询目标（锚点）" }
        return level > 0 ? "被调用 · 第 \(level) 层" : "调用者 · 第 \(-level) 层"
    }
}
