// Models.swift —— 核心数据结构
// 一条管线：SourceFile（源码文件）→ Analyzer → Definition（定义，含其调用点）→ CallGraph（节点+边）

import Foundation

// MARK: - 语言

/// 支持的语言。解析是「轻量正则」策略：覆盖常见工程 9 成代码，追求速度与零依赖。
enum Language: String, CaseIterable, Codable {
    case kotlin, java, swift, typescript, javascript, cfamily, python, go, objc

    var displayName: String {
        switch self {
        case .kotlin:     return "Kotlin"
        case .java:       return "Java"
        case .swift:      return "Swift"
        case .typescript: return "TypeScript"
        case .javascript: return "JavaScript"
        case .cfamily:    return "C/C++"
        case .python:     return "Python"
        case .go:         return "Go"
        case .objc:       return "ObjC"
        }
    }

    /// 按文件扩展名识别语言
    static func detect(_ ext: String) -> Language? {
        switch ext.lowercased() {
        case "kt", "kts":               return .kotlin
        case "java":                    return .java
        case "swift":                   return .swift
        case "ts", "tsx", "mts", "cts": return .typescript
        case "js", "jsx", "mjs", "cjs": return .javascript
        case "c", "h", "cpp", "hpp", "cc", "cxx", "hh": return .cfamily
        case "py":                      return .python
        case "go":                      return .go
        case "m", "mm":                 return .objc
        default:                        return nil
        }
    }
}

// MARK: - 源文件

/// 一个被扫描的源码文件（保留行数组，供详情/预览使用）
struct SourceFile: Identifiable, Codable {
    let path: String     // 绝对路径
    let relPath: String  // 相对项目根的路径（节点/结果里的展示路径）
    let language: Language
    var lines: [String] = []  // 原文行（不含换行符）

    var id: String { relPath }
}

// MARK: - 定义（函数/类/顶层代码）

/// 符号种类
enum DefinitionKind: String, Codable, CaseIterable {
    case function   // 函数/方法
    case klass      // 类/结构体/接口/枚举
    case topLevel   // 文件顶层代码（伪定义，承载未归属任何函数的调用）

    var icon: String {
        switch self {
        case .function: return "hammer"
        case .klass:    return "square.grid.3x3.square"
        case .topLevel: return "globe"
        }
    }
}

/// 一个代码定义（函数/方法/类/顶层块）。
/// 每个定义内部收集它「调用了谁」的调用点列表。
struct Definition: Identifiable, Codable {
    /// 唯一键：相对路径::名字::行号（同文件同名重载也能区分）
    let id: String
    let name: String
    let kind: DefinitionKind
    let file: String   // 相对路径
    let line: Int
    let column: Int
    let signature: String      // 定义行原文（粗略签名展示）
    var calls: [CallSite] = [] // 该定义体内的调用点
    var endLine: Int = 0       // 定义体结束行（分析结束后确定；0=未确定）

    /// 顶层块的展示名（全局调用）
    static func topLevelName(_ relPath: String) -> String {
        "顶层代码 · \((relPath as NSString).lastPathComponent)"
    }
}

// MARK: - 调用点

/// 一个调用点：在某文件某行调用了一个名字
struct CallSite: Identifiable, Codable, Hashable {
    var id: String { "\(file)::\(line)::\(column)" }
    let callee: String  // 被调用的名字（不一定能解析为定义）
    var file: String    // 相对路径（分析期临时为空，结束时统一填写）
    let line: Int
    let column: Int
    let code: String    // 该行原文（展示用）

    /// 简短展示：`文件:行`
    var shortLocation: String { "\((file as NSString).lastPathComponent):\(line)" }
}

// MARK: - 查询命中

/// 搜索结果项：要么命中一个定义名，要么命中某行文本
enum SearchHitKind: String, CaseIterable {
    case definition  // 定义名匹配（可绘制完整调用链）
    case text        // 行文本匹配（归属到所在定义）
}

struct SearchHit: Identifiable {
    var id: String { "\(kind.rawValue)::\(definition.id)::\(line)" }
    let kind: SearchHitKind
    let definition: Definition   // 命中所属的定义（text 命中时是包含该行的定义）
    let line: Int                // 命中行（definition 命中时 = 定义行）
    let code: String             // 命中行原文
}