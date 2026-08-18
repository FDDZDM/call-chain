// CLI.swift —— 命令行模式（无界面，供脚本/自动化/快速验证）
//
// 用法：
//   CallChain --analyze <目录> [--symbol <名称>] [--callers <层数>] [--callees <层数>]
//                    [--json] [--exclude <目录名,...>] [--maxfiles <N>]
// 示例：
//   CallChain --analyze ~/Projects/coros_app --symbol saveSession
//   CallChain --analyze ~/Projects/coros_app --symbol ExploreStore --json
// 不带 --symbol：输出统计摘要与符号清单。

import Foundation
import SwiftUI
import AppKit

enum CLI {

    static func run(arguments: [String]) -> Int32 {
        let args = Array(arguments.dropFirst())
        guard let dirIndex = args.firstIndex(of: "--analyze"),
              dirIndex + 1 < args.count else {
            print(usage)
            return 2
        }
        let dir = args[dirIndex + 1]
        let symbol = value(after: "--symbol", in: args)
        let callers = Int(value(after: "--callers", in: args) ?? "") ?? 2
        let callees = Int(value(after: "--callees", in: args) ?? "") ?? 2
        let json = args.contains("--json")
        let pngPath = value(after: "--png", in: args)
        var options = ScanOptions()
        if let ex = value(after: "--exclude", in: args) {
            options.extraExcludes = Set(ex.split(separator: ",").map(String.init))
        }
        if let mf = value(after: "--maxfiles", in: args), let n = Int(mf) {
            options.maxFiles = n
        }

        let url = URL(fileURLWithPath: dir)
        let t0 = Date()
        let session = AnalysisSession.run(url: url, options: options)
        let elapsed = String(format: "%.2f", Date().timeIntervalSince(t0))

        if json {
            print(sessionJSON(session, symbol: symbol, callers: callers,
                              callees: callees))
            return 0
        }

        print("=== CallChain 分析报告 ===")
        print("目录: \(url.path)")
        print("耗时: \(elapsed)s · 文件: \(session.files.count) · 定义: \(session.defs.count)")
        // 语言分布
        var langCount: [Language: Int] = [:]
        for f in session.files { langCount[f.language, default: 0] += 1 }
        let dist = langCount.keys.sorted { $0.displayName < $1.displayName }
            .map { "\($0.displayName) \(langCount[$0] ?? 0)" }
            .joined(separator: ", ")
        print("语言: \(dist)")
        print()

        guard let symbol else {
            print("--- 符号清单（前 40 个）---")
            for d in session.defs.prefix(40) {
                print("  [\(d.kind.rawValue.padding(toLength: 8, withPad: " ", startingAt: 0))]"
                      + " \(d.name)  \(d.file):\(d.line)")
            }
            if session.defs.count > 40 {
                print("  … 共 \(session.defs.count) 个（用 --symbol <名称> 查看某个符号的调用链）")
            }
            return 0
        }

        // 查找目标：精确名优先，再按包含匹配；函数优先于类
        let exact = session.defs.filter { $0.name == symbol && $0.kind != .topLevel }
        let fuzzy = session.defs.filter {
            $0.name.range(of: symbol, options: .caseInsensitive) != nil
                && $0.kind != .topLevel
        }
        let matches = exact.isEmpty ? fuzzy : exact
        let sorted = matches.sorted { (a, b) -> Bool in
            (a.kind == .function ? 0 : 1, a.file, a.line)
                < (b.kind == .function ? 0 : 1, b.file, b.line)
        }
        if sorted.isEmpty {
            print("未找到包含「\(symbol)」的定义。")
            return 1
        }
        print("--- 匹配定义（\(sorted.count) 个）---")
        for (i, d) in sorted.prefix(20).enumerated() {
            print("  \(i + 1). [\(d.kind.rawValue)] \(d.name)  \(d.file):\(d.line)")
        }
        print()
        let target = sorted[0]
        print("以第 1 个为锚点构建调用链：")
        print()

        var graph = GraphBuilder.build(allDefs: session.defs, target: target,
                                       callDepth: callees, callerDepth: callers)
        GraphLayout.layout(&graph)

        // 按层级输出
        let byLevel = Dictionary(grouping: graph.nodes) { $0.level }
        for level in byLevel.keys.sorted().reversed() {
            guard let nodes = byLevel[level] else { continue }
            if level == 0 {
                print("══ 锚点 ══")
            } else if level < 0 {
                print("══ 调用者 · 第 \(-level) 层（\(nodes.count) 个）══")
            } else {
                print("══ 被调用 · 第 \(level) 层（\(nodes.count) 个）══")
            }
            for node in nodes.sorted(by: { $0.def.file == $1.def.file
                                          ? $0.def.line < $1.def.line
                                          : $0.def.file < $1.def.file }) {
                print("  \(node.def.name)  \(node.def.file):\(node.def.line)")
                // 与锚点的直接调用点
                let sites = graph.edges.filter {
                    ($0.from == node.id && $0.to == target.id)
                        || ($0.to == node.id && $0.from == target.id)
                }
                if level == 0 {
                    print("    ↳ \(node.def.signature.trimmingCharacters(in: .whitespaces))")
                }
                for e in sites {
                    for s in e.sites {
                        print("    ↳ \(s.file):\(s.line)  \(s.code.trimmingCharacters(in: .whitespaces))")
                    }
                }
            }
            print()
        }

        print("--- 未解析调用（\(graph.unresolved.count) 个）---")
        for s in graph.unresolved.prefix(15) {
            print("  \(s.file):\(s.line)  \(s.code.trimmingCharacters(in: .whitespaces))")
        }
        print()
        print("图表统计: \(graph.nodes.count) 节点 · \(graph.edges.count) 边"
              + " · 未解析 \(graph.unresolved.count)")

        // --png <path>：无头导出调用链图（走与 GUI 相同的渲染管线）
        if let pngPath {
            MainActor.assumeIsolated {
                let size = CGSize(width: max(graph.bounds.width, 200),
                                  height: max(graph.bounds.height, 120))
                let renderer = ImageRenderer(content: GraphSnapshotView(graph: graph)
                    .frame(width: size.width, height: size.height))
                renderer.scale = 2
                guard let img = renderer.nsImage,
                      let tiff = img.tiffRepresentation,
                      let rep = NSBitmapImageRep(data: tiff),
                      let png = rep.representation(using: .png, properties: [:]) else {
                    print("PNG 导出失败")
                    return
                }
                try? png.write(to: URL(fileURLWithPath: pngPath))
                print("✅ PNG 已导出: \(pngPath)（\(size.width)x\(size.height) @2x = \(png.count) 字节）")
            }
        }
        return 0
    }

    // MARK: 参数辅助

    private static func value(after flag: String, in args: [String]) -> String? {
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    private static let usage = """
    CallChain 命令行模式
    用法: CallChain --analyze <目录> [选项]
    选项:
      --symbol <名称>   输出该符号的调用链（默认输出统计摘要）
      --callers <n>     调用者层数（默认 2）
      --callees <n>     被调用者层数（默认 2）
      --json            输出 JSON（适合脚本处理）
      --exclude <a,b>   额外跳过的目录名
      --maxfiles <N>    最多扫描文件数
    """

    // MARK: JSON 输出

    private struct JsonOut: Encodable {
        struct NodeOut: Encodable { let name: String; let kind: String
            let file: String; let line: Int; let level: Int }
        struct EdgeOut: Encodable { let from: String; let to: String
            struct Site: Encodable { let file: String; let line: Int }
            let sites: [Site] }
        var root: String
        var files: Int
        var definitions: Int
        var symbol: String?
        var anchor: NodeOut?
        var nodes: [NodeOut]
        var edges: [EdgeOut]
        var unresolved: [EdgeOut.Site]
    }

    private static func sessionJSON(_ session: AnalysisSession,
                                    symbol: String?, callers: Int,
                                    callees: Int) -> String {
        var out = JsonOut(root: "", files: session.files.count,
                          definitions: session.defs.count, symbol: symbol,
                          anchor: nil, nodes: [], edges: [], unresolved: [])
        if let symbol, let match = session.defs.first(where: {
            $0.name.range(of: symbol, options: .caseInsensitive) != nil
                && $0.kind != .topLevel
        }) {
            var graph = GraphBuilder.build(allDefs: session.defs, target: match,
                                           callDepth: callees, callerDepth: callers)
            GraphLayout.layout(&graph)
            out.anchor = JsonOut.NodeOut(name: match.name, kind: match.kind.rawValue,
                                         file: match.file, line: match.line, level: 0)
            out.nodes = graph.nodes.map {
                JsonOut.NodeOut(name: $0.def.name, kind: $0.def.kind.rawValue,
                                file: $0.def.file, line: $0.def.line, level: $0.level)
            }
            out.edges = graph.edges.map {
                JsonOut.EdgeOut(from: $0.from, to: $0.to,
                                sites: $0.sites.map {
                                    JsonOut.EdgeOut.Site(file: $0.file, line: $0.line)
                                })
            }
            out.unresolved = graph.unresolved.map {
                JsonOut.EdgeOut.Site(file: $0.file, line: $0.line)
            }
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return (try? String(data: encoder.encode(out), encoding: .utf8)) ?? "{}"
    }
}