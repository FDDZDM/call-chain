// FunctionExplainerTests.swift —— 函数说明与完整链行为测试

import Testing
@testable import CallChain

@Suite struct FunctionExplainerTests {

    private func source(_ text: String, name: String = "Service.swift") -> SourceFile {
        SourceFile(path: "/tmp/\(name)", relPath: name, language: .swift,
                   lines: text.components(separatedBy: "\n"))
    }

    @Test func sourceCommentTakesPriority() {
        let file = source("""
        /// 保存当前会话并刷新索引。
        func saveSession() {
            persist()
        }
        """)
        let def = Analyzer.analyze(file: file).first { $0.name == "saveSession" }!
        let insight = FunctionExplainer.explain(def, in: file)

        #expect(insight.basis == .sourceComment)
        #expect(insight.summary == "保存当前会话并刷新索引。")
        #expect(insight.facts.contains { $0.contains("persist") })
    }

    @Test func missingCommentFallsBackToNameAndCalls() {
        let file = source("""
        func loadProfile() {
            readCache()
            fetchRemote()
        }
        """)
        let def = Analyzer.analyze(file: file).first { $0.name == "loadProfile" }!
        let insight = FunctionExplainer.explain(def, in: file)

        #expect(insight.basis == .inferred)
        #expect(insight.summary.contains("加载"))
        #expect(insight.summary.contains("Profile"))
        #expect(insight.summary.contains("readCache"))
    }
}

@Suite struct FullChainTests {

    private func definitions(_ text: String) -> [Definition] {
        let file = SourceFile(path: "/tmp/Chain.swift", relPath: "Chain.swift",
                              language: .swift,
                              lines: text.components(separatedBy: "\n"))
        return Analyzer.analyze(file: file)
    }

    @Test func unlimitedDepthIncludesDeepReachableFunctions() {
        let defs = definitions("""
        func a() { b() }
        func b() { c() }
        func c() { d() }
        func d() { e() }
        func e() { f() }
        func f() {}
        """)
        let anchor = defs.first { $0.name == "a" }!
        let graph = GraphBuilder.build(allDefs: defs, target: anchor,
                                       callDepth: .max, callerDepth: .max)

        #expect(graph.nodes.contains { $0.def.name == "f" && $0.level == 5 })
        #expect(!graph.isTruncated)
    }

    @Test func fullChainReportsSafetyLimit() {
        let calls = (0..<65).map { "f\($0)()" }.joined(separator: "\n    ")
        let leaves = (0..<65).map { "func f\($0)() {}" }.joined(separator: "\n")
        let defs = definitions("""
        func root() {
            \(calls)
        }
        \(leaves)
        """)
        let anchor = defs.first { $0.name == "root" }!
        let graph = GraphBuilder.build(allDefs: defs, target: anchor,
                                       callDepth: .max, callerDepth: .max)

        #expect(graph.isTruncated)
        #expect(graph.nodes.count == GraphBuilder.maxPerLevel + 1)
    }
}
