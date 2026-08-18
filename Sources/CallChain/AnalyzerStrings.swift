// AnalyzerStrings.swift —— 注释/字符串剥离与括号、缩进工具
// 剥离后的文本与原文本 UTF-16 偏移一一对应（被剥离内容替换为空格），
// 这样正则匹配到的位置可以直接对应回原行。

import Foundation

enum AnalyzerStrings {

    /// 块注释/三引号字符串状态（跨行维护，由调用方持有）
    /// 规则：
    ///  - C 系 /* */ 块注释（Kotlin/Swift/TS/JS/C/ObjC 都有）
    ///  - Python 三引号字符串 """…""" / '''…''' 按块处理
    ///  - 行注释：// 和 Python/Go 的 #
    ///  - 字符串字面量 "…" '…' `…` 跳过（含转义）
    static func strip(_ line: String, language: Language,
                      inBlock: inout Bool) -> String {
        let ns = line as NSString
        var out = [unichar](repeating: 0x20, count: ns.length)
        var i = 0
        let len = ns.length
        let hasBlock = (language != .python)
        let hasHash = (language == .python || language == .go)

        while i < len {
            let c = ns.character(at: i)

            if inBlock {
                // 块注释结束
                if hasBlock, c == 0x2A /* * */, i + 1 < len,
                   ns.character(at: i + 1) == 0x2F /* / */ {
                    inBlock = false; i += 2; continue
                }
                // Python 三引号结束（与开始同符号）
                if language == .python, isTripleQuote(ns, at: i) {
                    inBlock = false; i += 3; continue
                }
                i += 1
                continue
            }

            // 行注释
            if c == 0x2F /* / */, i + 1 < len, ns.character(at: i + 1) == 0x2F { break }
            if hasHash, c == 0x23 /* # */ { break }
            // 块注释开始
            if hasBlock, c == 0x2F, i + 1 < len, ns.character(at: i + 1) == 0x2A {
                inBlock = true; i += 2; continue
            }
            // Python 三引号开始
            if language == .python, isTripleQuote(ns, at: i) {
                inBlock = true; i += 3; continue
            }
            // 普通字符串（含反引号；Python 的 ` 是操作符，不跳过）
            if c == 0x22 /* " */ || c == 0x27 /* ' */
                || (language != .python && c == 0x60 /* ` */) {
                let q = c
                i += 1
                while i < len {
                    if ns.character(at: i) == 0x5C /* \ */ { i += 2; continue }
                    if ns.character(at: i) == q { i += 1; break }
                    i += 1
                }
                continue
            }
            out[i] = c
            i += 1
        }
        return String(utf16CodeUnits: out, count: out.count)
    }

    /// 当前位置是否为 Python 三引号（""" 或 '''）
    private static func isTripleQuote(_ ns: NSString, at i: Int) -> Bool {
        guard i + 2 < ns.length else { return false }
        let c = ns.character(at: i)
        return (c == 0x22 || c == 0x27)
            && ns.character(at: i + 1) == c
            && ns.character(at: i + 2) == c
    }

    /// 一行中 { 与 } 的差值
    static func braceDelta(_ s: String) -> Int {
        var d = 0
        for u in s.utf16 {
            if u == 0x7B { d += 1 }        // {
            else if u == 0x7D { d -= 1 }   // }
        }
        return d
    }

    /// 位置 from 之后（同文本内）是否存在 `{`
    static func hasBraceAfter(_ s: String, from: Int) -> Bool {
        let ns = s as NSString
        guard from < ns.length else { return false }
        return ns.range(of: "{", options: [],
                        range: NSRange(location: from, length: ns.length - from))
            .location != NSNotFound
    }

    /// 行首缩进宽度（tab 按 4 格计）
    static func leadingIndent(_ s: String) -> Int {
        var n = 0
        for ch in s {
            if ch == " " { n += 1 }
            else if ch == "\t" { n += 4 }
            else { break }
        }
        return n
    }
}