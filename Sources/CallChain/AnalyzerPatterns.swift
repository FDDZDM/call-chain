// AnalyzerPatterns.swift —— 各语言的声明正则表与关键字黑名单
// 轻量解析策略：正则识别「函数/类声明」与「名字(」调用点，追求九成准确、零依赖、速度快。

import Foundation

/// 单个声明模式：正则 + 名字所在捕获组 + 符号种类
struct DeclPattern {
    let regex: NSRegularExpression
    let nameGroup: Int
    let kind: DefinitionKind
}

enum AnalyzerPatterns {

    /// 关键字黑名单：这些词出现在括号前是语法/类型/修饰符，不是函数调用
    static let keywords: Set<String> = [
        "if", "else", "for", "while", "switch", "case", "default", "return",
        "new", "throw", "throws", "try", "catch", "finally", "import", "export",
        "from", "function", "fun", "func", "def", "class", "struct", "interface",
        "enum", "extension", "protocol", "guard", "defer", "where", "when", "with",
        "assert", "require", "delete", "typeof", "instanceof", "in", "of", "do",
        "let", "const", "var", "static", "public", "private", "protected",
        "override", "open", "sealed", "abstract", "final", "suspend", "inline",
        "noinline", "crossinline", "expect", "actual", "external", "tailrec",
        "operator", "data", "companion", "object", "init", "super", "this",
        "async", "await", "yield", "break", "continue", "goto", "sizeof",
        "typedef", "typename", "namespace", "using", "template", "volatile",
        "register", "signed", "unsigned", "long", "short", "double", "float",
        "int", "char", "void", "bool", "auto", "constexpr", "noexcept",
        "as", "is", "not", "and", "or", "then", "each", "vararg", "sealed",
    ]

    /// 通用调用点正则：`名字(` 前可有泛型参数（`foo<T>(`）。捕获组 1 = 名字
    static let callRegex = try! NSRegularExpression(
        pattern: #"\b([A-Za-z_$][A-Za-z0-9_$]*)(?:<[^>]*>)?\s*\("#, options: [])

    /// 每语言声明模式表（顺序优先：函数先于类）。TypeScript 与 JavaScript 共用。
    static let table: [Language: [DeclPattern]] = [
        .kotlin: [
            // fun name( 或 fun A.B.name(（接收者函数取最后一段）
            DeclPattern(regex: rx(#"\bfun\s+(?:[A-Za-z_$][\w$]*\.)*([A-Za-z_$][\w$]*)\s*\("#),
                        nameGroup: 1, kind: .function),
            // class/interface/object/enum class
            DeclPattern(regex: rx(#"\b(?:data\s+|sealed\s+|enum\s+|abstract\s+|open\s+)?(?:class|interface|object)\s+([A-Za-z_$][\w$]*)"#),
                        nameGroup: 1, kind: .klass),
        ],
        .swift: [
            DeclPattern(regex: rx(#"\bfunc\s+([A-Za-z_$][\w$]*)\s*\("#),
                        nameGroup: 1, kind: .function),
            DeclPattern(regex: rx(#"\b(?:class|struct|enum|actor|protocol|extension)\s+([A-Za-z_$][\w$]*)"#),
                        nameGroup: 1, kind: .klass),
        ],
        .java: [
            // 方法：修饰符+返回类型+名字+参数+{或;（类型块=标识符token序列，不能从空白开始，
            // 否则 `    foo(1);` 会被误判成声明）
            DeclPattern(regex: rx(#"(?m)^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default)\s+)*((?:[\w$.<>?,\[\]]+\s*)+?)\s+([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:\{|;)"#),
                        nameGroup: 2, kind: .function),
            DeclPattern(regex: rx(#"\b(?:class|interface|enum|record|@interface)\s+([A-Za-z_$][\w$]*)"#),
                        nameGroup: 1, kind: .klass),
        ],
        .typescript: [
            DeclPattern(regex: rx(#"\bfunction\s+([A-Za-z_$][\w$]*)\s*\("#),
                        nameGroup: 1, kind: .function),
            // const/let/var name = (...) =>  /  = async (...) =>  /  = function(...) {
            DeclPattern(regex: rx(#"(?m)^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*)?\([^)]*\)\s*=>"#),
                        nameGroup: 1, kind: .function),
            // 类/对象方法简写：行首 名字(...) {（名字会经关键字过滤）
            DeclPattern(regex: rx(#"(?m)^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{"#),
                        nameGroup: 1, kind: .function),
            DeclPattern(regex: rx(#"\b(?:class|interface)\s+([A-Za-z_$][\w$]*)"#),
                        nameGroup: 1, kind: .klass),
        ],
        .cfamily: [
            DeclPattern(regex: rx(#"(?m)^\s*(?:(?:static|inline|extern|virtual|const|volatile|unsigned|signed|long|short|override|final|explicit|friend|typedef|struct|class|enum|union|namespace|template|typename|public|private|protected|constexpr|noexcept|register|thread_local)\s+)*((?:[\w$.<>?,\[\]:*&]+\s*)+?)\s+([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*\{"#),
                        nameGroup: 2, kind: .function),
            DeclPattern(regex: rx(#"\b(?:class|struct|enum|union)\s+([A-Za-z_$][\w$]*)"#),
                        nameGroup: 1, kind: .klass),
        ],
        .python: [
            DeclPattern(regex: rx(#"(?m)^\s*(?:async\s+)?def\s+([A-Za-z_$][\w$]*)\s*\("#),
                        nameGroup: 1, kind: .function),
            DeclPattern(regex: rx(#"(?m)^\s*class\s+([A-Za-z_$][\w$]*)"#),
                        nameGroup: 1, kind: .klass),
        ],
        .go: [
            DeclPattern(regex: rx(#"(?m)^\s*func\s+(?:\([^)]*\)\s+)?([A-Za-z_$][\w$]*)\([^)]*\)\s*\{"#),
                        nameGroup: 1, kind: .function),
            DeclPattern(regex: rx(#"\btype\s+([A-Za-z_$][\w$]*)\s+(?:struct|interface)"#),
                        nameGroup: 1, kind: .klass),
        ],
        .objc: [
            DeclPattern(regex: rx(#"(?m)^\s*[+-]\s*\([\w\s\*]+\)\s*([A-Za-z_$][\w$]*)(?::[^\{;]*)?\s*\{"#),
                        nameGroup: 1, kind: .function),
            DeclPattern(regex: rx(#"\b@(?:interface|implementation|protocol)\s+([A-Za-z_$][\w$]*)"#),
                        nameGroup: 1, kind: .klass),
        ],
    ]

    /// 取某语言的模式（JavaScript 复用 TypeScript 的）
    static func patterns(for lang: Language) -> [DeclPattern] {
        lang == .javascript ? (table[.typescript] ?? []) : (table[lang] ?? [])
    }

    private static func rx(_ p: String) -> NSRegularExpression {
        try! NSRegularExpression(pattern: p, options: [])
    }
}