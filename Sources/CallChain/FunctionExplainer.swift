// FunctionExplainer.swift —— 离线函数作用说明
// 优先读取紧邻声明的注释；没有注释时，再根据函数名、范围和关键调用生成可核验的摘要。

import Foundation

struct FunctionInsight: Equatable {
    enum Basis: Equatable {
        case sourceComment
        case inferred

        var label: String {
            switch self {
            case .sourceComment: return "来自源码注释"
            case .inferred:      return "根据名称与调用推断"
            }
        }

        var icon: String {
            switch self {
            case .sourceComment: return "text.quote"
            case .inferred:      return "sparkles"
            }
        }
    }

    let summary: String
    let basis: Basis
    let facts: [String]
}

enum FunctionExplainer {

    static func explain(_ definition: Definition, in file: SourceFile?) -> FunctionInsight {
        let comment = file.flatMap { leadingComment(for: definition, in: $0) }
        let calls = uniqueCalls(in: definition)
        var facts: [String] = []

        let endLine = max(definition.line, definition.endLine)
        if endLine > definition.line {
            facts.append("实现范围：第 \(definition.line)–\(endLine) 行")
        } else {
            facts.append("定义位置：第 \(definition.line) 行")
        }
        if !calls.isEmpty {
            facts.append("关键调用：" + calls.prefix(5).joined(separator: "、"))
        }
        let signature = definition.signature.trimmingCharacters(in: .whitespacesAndNewlines)
        if !signature.isEmpty, definition.kind != .topLevel {
            facts.append("声明：\(shorten(signature, limit: 120))")
        }

        if let comment, !comment.isEmpty {
            return FunctionInsight(summary: comment, basis: .sourceComment, facts: facts)
        }

        return FunctionInsight(summary: inferredSummary(for: definition, calls: calls),
                               basis: .inferred,
                               facts: facts)
    }

    private static func inferredSummary(for definition: Definition,
                                        calls: [String]) -> String {
        switch definition.kind {
        case .topLevel:
            return calls.isEmpty
                ? "承载该文件中不属于任何函数或类型的顶层代码。"
                : "执行文件级入口逻辑，并串联 \(calls.prefix(3).joined(separator: "、")) 等调用。"
        case .klass:
            return "定义「\(definition.name)」类型及其相关能力。"
        case .function:
            break
        }

        let tokens = nameTokens(definition.name)
        let verb = tokens.first?.lowercased() ?? definition.name.lowercased()
        let objectTokens = Array(tokens.dropFirst())
        let object = objectTokens.joined(separator: " ")
        let action = actions[verb] ?? "处理"
        var summary = object.isEmpty
            ? "负责\(action)相关逻辑。"
            : "负责\(action)「\(object)」相关逻辑。"

        if !calls.isEmpty {
            summary += " 内部主要协作 \(calls.prefix(3).joined(separator: "、"))。"
        }
        return summary
    }

    private static let actions: [String: String] = [
        "get": "获取", "read": "读取", "load": "加载", "fetch": "获取",
        "find": "查找", "search": "搜索", "query": "查询", "lookup": "查找",
        "list": "列出", "scan": "扫描", "analyze": "分析", "parse": "解析",
        "decode": "解码", "encode": "编码", "format": "格式化",
        "render": "渲染", "draw": "绘制", "layout": "布局",
        "set": "设置", "update": "更新", "edit": "编辑", "apply": "应用",
        "save": "保存", "store": "存储", "persist": "持久化", "write": "写入",
        "create": "创建", "build": "构建", "make": "创建", "generate": "生成",
        "init": "初始化", "setup": "配置", "configure": "配置",
        "delete": "删除", "remove": "移除", "clear": "清理", "reset": "重置",
        "validate": "校验", "check": "检查", "verify": "验证", "ensure": "确保",
        "is": "判断", "has": "判断", "can": "判断",
        "send": "发送", "upload": "上传", "publish": "发布", "notify": "通知",
        "receive": "接收", "download": "下载", "sync": "同步",
        "import": "导入", "export": "导出", "copy": "复制",
        "open": "打开", "close": "关闭", "show": "展示", "hide": "隐藏",
        "select": "选择", "toggle": "切换", "schedule": "调度",
        "resolve": "解析", "rebuild": "重新构建", "run": "执行",
        "execute": "执行", "process": "处理", "handle": "处理"
    ]

    private static func uniqueCalls(in definition: Definition) -> [String] {
        var seen = Set<String>()
        return definition.calls.compactMap { site in
            guard site.callee != definition.name, seen.insert(site.callee).inserted else {
                return nil
            }
            return site.callee
        }
    }

    /// 从声明上方读取连续的行注释或块注释，并返回第一条有意义的说明。
    private static func leadingComment(for definition: Definition,
                                       in file: SourceFile) -> String? {
        var index = definition.line - 2
        guard index >= 0, index < file.lines.count else { return nil }

        // 允许注释与声明之间有一个空行。
        if file.lines[index].trimmingCharacters(in: .whitespaces).isEmpty {
            index -= 1
        }

        var lines: [String] = []
        var sawBlockEnd = false
        while index >= 0, lines.count < 12 {
            let trimmed = file.lines[index].trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { break }

            let isLineComment = trimmed.hasPrefix("//")
                || (file.language == .python && trimmed.hasPrefix("#"))
            let isBlockPart = trimmed.hasPrefix("/*") || trimmed.hasPrefix("*")
                || trimmed.hasSuffix("*/") || sawBlockEnd
            guard isLineComment || isBlockPart else { break }

            if trimmed.hasSuffix("*/") { sawBlockEnd = true }
            lines.append(cleanCommentLine(trimmed))
            if trimmed.hasPrefix("/*") { sawBlockEnd = false }
            index -= 1
        }

        let meaningful = lines.reversed().filter { line in
            !line.isEmpty && !line.hasPrefix("@") && !line.hasPrefix("TODO")
                && !line.hasPrefix("MARK:")
        }
        guard let first = meaningful.first else { return nil }
        return shorten(first, limit: 180)
    }

    private static func cleanCommentLine(_ line: String) -> String {
        var out = line
        for prefix in ["///", "//!", "//", "/**", "/*", "*", "#"] {
            if out.hasPrefix(prefix) {
                out.removeFirst(prefix.count)
                break
            }
        }
        if out.hasSuffix("*/") { out.removeLast(2) }
        return out.trimmingCharacters(in: .whitespaces)
    }

    private static func nameTokens(_ name: String) -> [String] {
        let normalized = name.replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: "$", with: " ")
        let pattern = #"[A-Z]+(?=[A-Z][a-z]|\b)|[A-Z]?[a-z]+|[0-9]+"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            return normalized.split(separator: " ").map(String.init)
        }
        let ns = normalized as NSString
        let matches = regex.matches(in: normalized,
                                    range: NSRange(location: 0, length: ns.length))
        let tokens = matches.map { ns.substring(with: $0.range) }
        return tokens.isEmpty ? [name] : tokens
    }

    private static func shorten(_ text: String, limit: Int) -> String {
        guard text.count > limit else { return text }
        return String(text.prefix(limit - 1)) + "…"
    }
}
