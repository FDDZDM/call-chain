// AnalyzerCore.swift —— 分析主流程
// 逐行扫描：剥离注释/字符串 → 识别声明 → 绑定调用点 → 括号深度(或缩进)作用域跟踪。
// 花括号语言用「括号深度」判定函数体边界；Python 用「缩进」判定。

import Foundation

/// 分析期的可变定义节点（class 引用语义，方便就地追加调用点；结束后转 struct Definition）
final class DefNode {
    let name: String
    let kind: DefinitionKind
    var file = ""          // 相对路径（分析结束统一填写）
    var line: Int          // 声明行号（分析前为 0，遇到声明行时填写）
    let column: Int
    var signature = ""     // 定义行原文
    var calls: [CallSite] = []
    var braceDepth = 0     // 声明处括号深度（花括号语言）
    var hasBraceBody = false
    var endLine = 0        // 函数体结束行
    var indent = 0         // 声明行缩进（Python）

    init(name: String, kind: DefinitionKind, line: Int, column: Int) {
        self.name = name; self.kind = kind; self.line = line; self.column = column
    }

    var id: String { "\(file)::\(name)::\(line)::\(column)" }

    func makeDefinition() -> Definition {
        Definition(id: id, name: name, kind: kind, file: file,
                   line: line, column: column, signature: signature,
                   calls: calls, endLine: endLine)
    }
}

enum Analyzer {

    /// 分析一个文件，返回其中的所有定义（含文件顶层块的伪定义）
    static func analyze(file: SourceFile) -> [Definition] {
        let lang = file.language
        let indentBased = (lang == .python)

        var defs: [DefNode] = []
        var stack: [DefNode] = []
        var globalCalls: [CallSite] = []
        var depth = 0
        var inBlock = false

        for (idx, rawLine) in file.lines.enumerated() {
            let lineNo = idx + 1
            let clean = AnalyzerStrings.strip(rawLine, language: lang, inBlock: &inBlock)

            if indentBased {
                processPythonLine(rawLine, clean, lineNo, &stack, &defs, &globalCalls)
                continue
            }

            processBraceLine(rawLine, clean, lineNo, lang, &stack, &defs,
                             &globalCalls, &depth)
        }

        // 文件结束：未闭合的定义收尾
        for d in defs { if d.endLine == 0 { d.endLine = file.lines.count } }

        // 顶层块伪定义（未归属任何函数的调用）
        if !globalCalls.isEmpty, let first = globalCalls.first {
            let top = DefNode(name: Definition.topLevelName(file.relPath),
                              kind: .topLevel, line: first.line, column: 0)
            top.signature = "文件顶层代码（未归属任何函数的调用）"
            top.calls = globalCalls
            top.endLine = file.lines.count
            defs.append(top)
        }

        // 统一填写相对路径并去重，转成不可变 struct
        var seen = Set<String>()
        return defs.compactMap { d -> Definition? in
            d.file = file.relPath
            for i in d.calls.indices { d.calls[i].file = file.relPath }
            guard seen.insert(d.id).inserted else { return nil }
            return d.makeDefinition()
        }
        .sorted { ($0.line, $0.column) < ($1.line, $1.column) }
    }

    // MARK: - 花括号语言：单行处理

    private static func processBraceLine(
        _ raw: String, _ clean: String, _ lineNo: Int, _ lang: Language,
        _ stack: inout [DefNode], _ defs: inout [DefNode],
        _ globalCalls: inout [CallSite], _ depth: inout Int
    ) {
        let ns = clean as NSString
        // 超长行跳过声明匹配：声明语句不会超过 500 字符，
        // 且 token 型正则（Java/C-family）在超长压缩行上会灾难性回溯
        let decl = clean.count <= 500 ? firstDecl(in: clean, language: lang) : nil
        let callRanges = nameRanges(in: clean)

        // 事件表：(位置, 次序)——同一位置声明先于调用
        var events: [(pos: Int, ord: Int)] = []
        if let d = decl { events.append((d.column, 0)) }
        for r in callRanges { events.append((r.location, 1)) }
        events.sort { $0.pos != $1.pos ? $0.pos < $1.pos : $0.ord < $1.ord }

        var runDepth = depth
        var last = 0
        var pending: DefNode?   // 本行新声明的定义（其后调用归它）

        for ev in events {
            let seg = ns.substring(with: NSRange(location: last, length: ev.pos - last))
            runDepth += AnalyzerStrings.braceDelta(seg)
            last = ev.pos

            if ev.ord == 0, let d = decl {
                // 表达式体函数（无花括号）不跨行，行尾弹出；压栈前先清掉此类残留
                while let top = stack.last, !top.hasBraceBody { stack.removeLast() }
                d.line = lineNo
                d.signature = raw
                d.braceDepth = runDepth
                let paren = ns.range(of: "(", options: [],
                                     range: NSRange(location: d.column,
                                                    length: ns.length - d.column))
                d.hasBraceBody = paren.location != NSNotFound
                    && AnalyzerStrings.hasBraceAfter(clean, from: paren.upperBound)
                stack.append(d)
                defs.append(d)
                pending = d
            } else {
                let name = captureName(ns, at: ev.pos)
                if name.isEmpty || AnalyzerPatterns.keywords.contains(name) { continue }
                // 声明行上声明者自身的括号不算调用
                if let pd = pending, name == pd.name && ev.pos == pd.column { continue }
                let owner = pending ?? stack.last
                let site = CallSite(callee: name, file: "", line: lineNo,
                                    column: ev.pos, code: raw)
                if let owner { owner.calls.append(site) } else { globalCalls.append(site) }
            }
        }

        if last < ns.length {
            runDepth += AnalyzerStrings.braceDelta(ns.substring(
                with: NSRange(location: last, length: ns.length - last)))
        }
        depth = runDepth

        // 行尾收尾：① 表达式体定义立即结束；② 括号深度回到声明深度的定义闭合
        while let top = stack.last, !top.hasBraceBody { stack.removeLast().endLine = lineNo }
        let lineHasCloseBrace = ns.range(of: "}").location != NSNotFound
        while let top = stack.last, depth <= top.braceDepth,
              (top.hasBraceBody || lineHasCloseBrace) {
            stack.removeLast().endLine = lineNo
        }
    }

    // MARK: - Python：缩进作用域

    private static func processPythonLine(
        _ raw: String, _ clean: String, _ lineNo: Int,
        _ stack: inout [DefNode], _ defs: inout [DefNode],
        _ globalCalls: inout [CallSite]
    ) {
        let indent = AnalyzerStrings.leadingIndent(raw)
        // 缩进回到声明行（含）以下 → 函数体结束
        while let top = stack.last, indent <= top.indent { stack.removeLast().endLine = lineNo }
        // 超长行同样跳过声明匹配（防正则回溯）
        let decl = clean.count <= 500 ? firstDecl(in: clean, language: .python) : nil
        if let d = decl {
            // 定义行自身不当作调用（参数默认值等调用仍归外层）
            attachCalls(clean, raw, lineNo, to: stack.last,
                        skip: (d.name, d.column), global: &globalCalls)
            d.line = lineNo
            d.signature = raw
            d.indent = indent
            d.endLine = lineNo
            stack.append(d)
            defs.append(d)
        } else {
            attachCalls(clean, raw, lineNo, to: stack.last,
                        skip: nil, global: &globalCalls)
        }
    }

    /// 把一行中的调用点挂到 owner（nil 时进 global），skip 可跳过某个名字
    private static func attachCalls(
        _ clean: String, _ raw: String, _ lineNo: Int,
        to owner: DefNode?, skip: (name: String, column: Int)?,
        global: inout [CallSite]
    ) {
        let ns = clean as NSString
        for r in nameRanges(in: clean) {
            let name = captureName(ns, at: r.location)
            if name.isEmpty || AnalyzerPatterns.keywords.contains(name) { continue }
            if let skip, skip.name == name && skip.column == r.location { continue }
            let site = CallSite(callee: name, file: "", line: lineNo,
                                column: r.location, code: raw)
            if let owner { owner.calls.append(site) } else { global.append(site) }
        }
    }

    // MARK: - 行内匹配

    /// 行内第一个声明（多模式按顺序尝试），返回零时状态的 DefNode
    private static func firstDecl(in clean: String, language: Language) -> DefNode? {
        let patterns = AnalyzerPatterns.patterns(for: language)
        let ns = clean as NSString
        for p in patterns {
            guard let m = p.regex.firstMatch(in: clean,
                                             range: NSRange(location: 0, length: ns.length))
            else { continue }
            let nr = m.range(at: p.nameGroup)
            guard nr.location != NSNotFound else { continue }
            let name = ns.substring(with: nr)
            guard !AnalyzerPatterns.keywords.contains(name) else { continue }
            // 名字前紧邻 new（new Foo( → 是构造调用不是声明）
            let prefix = ns.substring(with: NSRange(location: 0, length: nr.location))
                .trimmingCharacters(in: .whitespaces)
            if prefix.hasSuffix("new") { continue }
            return DefNode(name: name, kind: p.kind, line: 0, column: nr.location)
        }
        return nil
    }

    /// 全部调用点的「名字」NSRange 列表
    private static func nameRanges(in clean: String) -> [NSRange] {
        let ns = clean as NSString
        var ranges: [NSRange] = []
        AnalyzerPatterns.callRegex.enumerateMatches(
            in: clean, range: NSRange(location: 0, length: ns.length)
        ) { m, _, _ in
            guard let m else { return }
            let nr = m.range(at: 1)
            if nr.location != NSNotFound { ranges.append(nr) }
        }
        return ranges
    }

    /// 取名字组内容
    private static func captureName(_ ns: NSString, at location: Int) -> String {
        // 名字组范围 = 从 location 起直到非单词字符
        var length = 0
        var i = location
        while i < ns.length {
            let c = ns.character(at: i)
            if (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A)
                || (c >= 0x30 && c <= 0x39) || c == 0x5F || c == 0x24 {
                length += 1
            } else { break }
            i += 1
        }
        return ns.substring(with: NSRange(location: location, length: length))
    }
}