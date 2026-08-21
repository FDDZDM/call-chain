// SearchTests.swift —— 搜索引擎与目录树测试

import Testing
import Foundation
@testable import CallChain

@Suite struct SearchTests {

    private func session(files: [(String, String, Language)]) -> AnalysisSession {
        var sources: [SourceFile] = []
        for (relPath, text, lang) in files {
            sources.append(SourceFile(path: "/tmp/" + relPath, relPath: relPath,
                                      language: lang,
                                      lines: text.components(separatedBy: "\n")))
        }
        var defs: [Definition] = []
        var defsByFile: [String: [Definition]] = [:]
        var idx: [String: SourceFile] = [:]
        for f in sources {
            let d = Analyzer.analyze(file: f)
            defs.append(contentsOf: d)
            defsByFile[f.relPath] = d
            idx[f.relPath] = f
        }
        return AnalysisSession(files: sources, defs: defs,
                               defsByFile: defsByFile, fileIndex: idx)
    }

    private func owners(_ s: AnalysisSession, _ rel: String) -> [Int] {
        SearchEngine.buildLineOwners(file: s.fileIndex[rel]!,
                                     defs: s.defsByFile[rel] ?? [])
    }

    @Test func searchFindsDefinitionAndTextHits() {
        let s = session(files: [
            ("a/Main.kt", """
            package demo
            fun hello() {
                world()
            }
            fun world() {}
            """, .kotlin),
            ("b/Sub.kt", """
            fun util() {
                hello()
            }
            """, .kotlin),
        ])
        let res = SearchEngine.search(files: s.files, defsByFile: s.defsByFile,
                                      lineOwners: Dictionary(uniqueKeysWithValues: s.files.map {
                                          ($0.relPath, owners(s, $0.relPath))
                                      }),
                                      query: "hello", scopeProject: true,
                                      currentFile: nil)
        // 定义名命中 2 个（hello 定义 + 被 util 调用处文本命中）
        let defHits = res.hits.filter { $0.kind == .definition }
        #expect(defHits.contains { $0.definition.name == "hello" })
        // 文本命中：util 里的 hello() 调用行（Sub.kt 第 2 行）
        let textHits = res.hits.filter { $0.kind == .text }
        #expect(textHits.contains { $0.line == 2 && $0.definition.name == "util" })
        #expect(!res.truncated)
    }

    @Test func localScopeOnlySearchesCurrentFile() {
        let s = session(files: [
            ("a.kt", "fun target() {}\n", .kotlin),
            ("b.kt", "fun target() {}\n", .kotlin),
        ])
        // 全局：两个定义都命中
        let g = SearchEngine.search(files: s.files, defsByFile: s.defsByFile,
                                    lineOwners: [:], query: "target",
                                    scopeProject: true, currentFile: "b.kt")
        #expect(g.hits.filter { $0.kind == .definition }.count == 2)
        // 局部：只命中当前文件
        let l = SearchEngine.search(files: s.files, defsByFile: s.defsByFile,
                                    lineOwners: [:], query: "target",
                                    scopeProject: false, currentFile: "a.kt")
        let defs = l.hits.filter { $0.kind == .definition }
        #expect(defs.count == 1)
        #expect(defs[0].definition.file == "a.kt")
    }

    @Test func lineOwnerIndexAttributesLinesCorrectly() {
        let s = session(files: [
            ("a.kt", """
            fun outer() {
                inner()
                fun inner() {
                    deep()
                }
                after()
            }
            """, .kotlin),
        ])
        let owners = self.owners(s, "a.kt")
        let defs = s.defsByFile["a.kt"]!
        func name(atLine line: Int) -> String? {
            let idx = owners[line]
            guard idx > 0, idx <= defs.count else { return nil }
            return defs[idx - 1].name
        }
        #expect(name(atLine: 1) == "outer")
        #expect(name(atLine: 2) == "outer")     // inner() 调用行归 outer
        #expect(name(atLine: 3) == "inner")
        #expect(name(atLine: 4) == "inner")     // deep() 在 inner 体内
        #expect(name(atLine: 5) == "inner")     // inner 的结束行仍归 inner
        #expect(name(atLine: 6) == "outer")     // after() 调用行归 outer
    }

    /// 性能回归：50 个文件 × 2000 行 = 10 万行，全量搜索应远低于 1 秒
    @Test func searchPerformanceTenMillionChars() async {
        var files: [SourceFile] = []
        var defsByFile: [String: [Definition]] = [:]
        var ownersMap: [String: [Int]] = [:]
        for i in 0..<50 {
            let rel = "gen/File\(i).kt"
            var lines: [String] = ["fun f\(i)() {"]
            for j in 0..<1998 {
                lines.append("    val x = helper_\(j % 50)(a)  // filler line \(j) content")
            }
            lines.append("}")
            let f = SourceFile(path: "/tmp/" + rel, relPath: rel, language: .kotlin,
                               lines: lines)
            let defs = Analyzer.analyze(file: f)
            files.append(f)
            defsByFile[rel] = defs
            ownersMap[rel] = SearchEngine.buildLineOwners(file: f, defs: defs)
        }
        let clock = ContinuousClock()
        let t = clock.measure {
            _ = SearchEngine.search(files: files, defsByFile: defsByFile,
                                    lineOwners: ownersMap,
                                    query: "filler", scopeProject: true,
                                    currentFile: nil)
        }
        let secs = Double(t.components.seconds)
            + Double(t.components.attoseconds) / 1e18
        #expect(secs < 1.0, "搜索 10 万行耗时 \(String(format: "%.3f", secs))s，超过 1s 上限")
    }

    @MainActor
    @Test func directoryTreeGroupsByPath() {
        let s = session(files: [
            ("a/b/c.kt", "fun c() {}\n", .kotlin),
            ("a/b/d.kt", "fun d() {}\n", .kotlin),
            ("a/e.kt", "fun e() {}\n", .kotlin),
            ("f.kt", "fun f() {}\n", .kotlin),
        ])
        let store = ProjectStore()
        store.files = s.files
        let tree = store.buildTree()
        // 根：目录 a 在前、文件 f.kt
        #expect(tree.count == 2)
        #expect(tree[0].id == "d:a")
        #expect(tree[1].id == "f:f.kt")
        // a 下：目录 b + 文件 e.kt
        if case .directory(_, _, let children) = tree[0].kind {
            #expect(children.count == 2)
            #expect(children[0].id == "d:a/b")
            #expect(children[1].id == "f:a/e.kt")
            if case .directory(_, _, let leafDirs) = children[0].kind {
                #expect(leafDirs.count == 2)
                #expect(leafDirs[0].id == "f:a/b/c.kt")
                #expect(leafDirs[1].id == "f:a/b/d.kt")
            }
        } else {
            Issue.record("预期 a 是目录")
        }
    }

    @MainActor
    @Test func textHitKeepsExactStatementAsGraphFocus() {
        let s = session(files: [
            ("Flow.kt", """
            fun start() {
                nextStep()
            }
            fun nextStep() {}
            """, .kotlin),
        ])
        let owner = s.defs.first { $0.name == "start" }!
        let hit = SearchHit(kind: .text, definition: owner, line: 2,
                            code: "    nextStep()")
        let store = ProjectStore()
        store.allDefs = s.defs

        store.anchorSearchHit(hit)

        #expect(store.anchor?.id == owner.id)
        #expect(store.focusedStatement?.line == 2)
        #expect(store.focusedStatement?.code.contains("nextStep") == true)
        #expect(store.graph?.edges.contains { edge in
            edge.sites.contains { $0.line == 2 && $0.callee == "nextStep" }
        } == true)
    }
}
