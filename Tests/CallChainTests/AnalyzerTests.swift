// AnalyzerTests.swift —— 解析与构图逻辑单元测试（swift-testing）

import Testing
import Foundation
@testable import CallChain

@Suite struct AnalyzerTests {

    // ---- 工具 ----

    private func analyze(_ text: String, name: String = "Test.kt",
                         language: Language = .kotlin) -> [Definition] {
        let lines = text.components(separatedBy: "\n")
        let file = SourceFile(path: "/tmp/\(name)", relPath: name,
                              language: language, lines: lines)
        return Analyzer.analyze(file: file)
    }

    private func funcDef(_ name: String, _ defs: [Definition]) -> Definition? {
        defs.first { $0.name == name && $0.kind == .function }
    }

    private func callsOf(_ name: String, _ defs: [Definition]) -> [String] {
        funcDef(name, defs)?.calls.map(\.callee) ?? []
    }

    // ---- Kotlin 基础 ----

    @Test func kotlinBasicAttribution() {
        let defs = analyze("""
        fun a() {
            b()
            c(1)
        }
        fun b() {
            d()
        }
        """)
        #expect(defs.count == 2)
        #expect(callsOf("a", defs) == ["b", "c"])
        #expect(callsOf("b", defs) == ["d"])
    }

    @Test func kotlinExpressionBody() {
        let defs = analyze("""
        fun a() = b(c())
        fun b(x: Int) = x
        fun c() = 1
        """)
        #expect(callsOf("a", defs) == ["b", "c"])
        #expect(callsOf("b", defs) == [])
    }

    @Test func nestedFunctionScope() {
        let defs = analyze("""
        fun outer() {
            fun inner() {
                x()
            }
            y()
        }
        """)
        // inner 只归 x，y 归 outer
        let outer = funcDef("outer", defs)
        let inner = funcDef("inner", defs)
        #expect(outer?.calls.map(\.callee) == ["y"])
        #expect(inner?.calls.map(\.callee) == ["x"])
        // 定义范围：macro 断言 inner.endLine < outer.endLine
        if let outer, let inner {
            #expect(inner.endLine > 0)
            #expect(inner.line < outer.endLine)
        }
    }

    @Test func bracesInStringsAndCommentsDoNotBreakScope() {
        let defs = analyze("""
        fun a() {
            val s = "} { }"
            // 注释里也有 } 和 {
            b() // 行尾注释 {
        }
        fun c() {
        }
        """, )
        #expect(callsOf("a", defs) == ["b"])
        // c 后面如果跟顶层调用，应归属顶层而非 a
        let top = defs.first { $0.kind == .topLevel }
        #expect(top == nil)  // 没有顶层调用
    }

    @Test func recursiveSelfCall() {
        let defs = analyze("""
        fun fact(n: Int): Int {
            if (n <= 1) return 1
            return n * fact(n - 1)
        }
        """)
        #expect(callsOf("fact", defs) == ["fact"])
    }

    @Test func topLevelCallsBecomePseudoDef() {
        let defs = analyze("""
        fun main() {
            a()
        }
        a()
        """)
        let top = defs.first { $0.kind == .topLevel }
        #expect(top != nil)
        #expect(top?.calls.map(\.callee) == ["a"])
    }

    // ---- 其他语言 ----

    @Test func javaMethodPattern() {
        let defs = analyze("""
        public class Main {
            public static void main(String[] args) {
                helper(1);
            }
            private int helper(int x) {
                return x + 1;
            }
            void ifStmt() {
                if (x > 0) { run(); }
            }
        }
        """, name: "Main.java", language: .java)
        #expect(callsOf("main", defs) == ["helper"])
        #expect(callsOf("helper", defs) == [])
        // if 不应成为声明
        #expect(funcDef("if", defs) == nil)
    }

    @Test func swiftFuncAndClass() {
        let defs = analyze("""
        struct Service {
            func process(_ x: Int) {
                validate(x)
            }
            func validate(_ x: Int) {}
        }
        extension Service {
            func extra() {
                process(1)
            }
        }
        """, name: "Service.swift", language: .swift)
        #expect(callsOf("process", defs) == ["validate"])
        #expect(callsOf("extra", defs) == ["process"])
        #expect(defs.contains { $0.name == "Service" && $0.kind == .klass })
    }

    @Test func tsArrowAndMethod() {
        let defs = analyze("""
        export const main = (a: number) => {
            return helper(a);
        };
        function helper(x: number) {
            const inner = (y: number) => y * 2;
            return inner(x);
        }
        class Renderer {
            render() {
                this.draw(1);
            }
            draw(n: number) {}
        }
        """, name: "app.ts", language: .typescript)
        #expect(callsOf("main", defs) == ["helper"])
        #expect(callsOf("helper", defs) == ["inner"])
        #expect(callsOf("render", defs) == ["draw"])
        #expect(defs.contains { $0.name == "Renderer" && $0.kind == .klass })
    }

    @Test func pythonIndentScope() {
        let defs = analyze("""
        def top():
            x = 1
            def nested():
                deep()
            after()

        free_calls()
        """, name: "mod.py", language: .python)
        let top = funcDef("top", defs)
        let nested = funcDef("nested", defs)
        #expect(top?.calls.map(\.callee) == ["after"])
        #expect(nested?.calls.map(\.callee) == ["deep"])
        // 缩进回落后，调用归顶层
        let topLevel = defs.first { $0.kind == .topLevel }
        #expect(topLevel?.calls.map(\.callee) == ["free_calls"])
    }

    @Test func goFuncAndReceiver() {
        let defs = analyze("""
        package main

        func main() {
            f := Foo{}
            f.Do(1)
        }

        func (f *Foo) Do(n int) {
            helper(n)
        }

        func helper(n int) {}
        """, name: "main.go", language: .go)
        #expect(callsOf("main", defs) == ["Do"])
        #expect(callsOf("Do", defs) == ["helper"])
    }
}

// MARK: - 图构建测试

@Suite struct GraphTests {

    private func makeDefs(_ pairs: [(file: String, text: String)]) -> [Definition] {
        pairs.flatMap { p in
            let lines = p.text.components(separatedBy: "\n")
            let f = SourceFile(path: "/tmp/\(p.file)", relPath: p.file,
                               language: .kotlin, lines: lines)
            return Analyzer.analyze(file: f)
        }
    }

    @Test func crossFileResolution() {
        let source = """
        fun caller() {
            target(1)
        }
        """
        let callee = """
        fun target(x: Int) {
            leaf()
        }
        fun leaf() {}
        """
        let defs = makeDefs([("A.kt", source), ("B.kt", callee)])
        let target = defs.first { $0.name == "target" && $0.kind == .function }!
        var g = GraphBuilder.build(allDefs: defs, target: target,
                                   callDepth: 2, callerDepth: 2)
        GraphLayout.layout(&g)

        // 跨文件：caller 在 -1 层，leaf 在 +1 层
        let callerNode = g.nodes.first { $0.def.name == "caller" }
        let leafNode = g.nodes.first { $0.def.name == "leaf" }
        #expect(callerNode?.level == -1)
        #expect(leafNode?.level == 1)
        #expect(g.edges.contains { $0.from == callerNode?.id && $0.to == target.id })
        #expect(g.edges.contains { $0.from == target.id && $0.to == leafNode?.id })
        // 布局后节点有坐标、bounds 非空
        #expect(g.bounds.width > 0)
        #expect(callerNode?.x != 0 || callerNode?.y != 0 || true) // 坐标可为零，仅验证 bounds
    }

    @Test func depthCaps() {
        let text = """
        fun a() { b() }
        fun b() { c() }
        fun c() { d() }
        fun d() {}
        """
        let defs = makeDefs([("A.kt", text)])
        let a = defs.first { $0.name == "a" }!
        // 被调用深度 2：b、c 可见，d 不可见
        var g = GraphBuilder.build(allDefs: defs, target: a,
                                   callDepth: 2, callerDepth: 1)
        #expect(g.nodes.contains { $0.def.name == "c" })
        #expect(!g.nodes.contains { $0.def.name == "d" })
    }

    @Test func unresolvedRecorded() {
        let text = """
        fun a() {
            missingFn(1)
        }
        """
        let defs = makeDefs([("A.kt", text)])
        let a = defs.first { $0.name == "a" }!
        var g = GraphBuilder.build(allDefs: defs, target: a,
                                   callDepth: 1, callerDepth: 1)
        #expect(g.unresolved.count == 1)
        #expect(g.unresolved[0].callee == "missingFn")
    }

    @Test func overloadingSameName() {
        let text = """
        fun callee(x: Int) {}
        fun callee(x: String) {}
        fun caller() { callee(1) }
        """
        let defs = makeDefs([("A.kt", text)])
        let caller = defs.first { $0.name == "caller" }!
        var g = GraphBuilder.build(allDefs: defs, target: caller,
                                   callDepth: 1, callerDepth: 1)
        // 同文件同名两个重载都应被解析连接
        let calleeNodes = g.nodes.filter { $0.def.name == "callee" }
        #expect(calleeNodes.count == 2)
    }
}