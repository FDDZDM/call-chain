// SearchEngine.swift —— 搜索纯函数（后台线程执行，零 UI 依赖）
// 解决卡死三步：① 不在主线程跑 ② 预建「行→定义」索引，归属查询 O(1)
// ③ 扫描行数预算封顶，超限即停并报 truncated。

import Foundation

enum SearchEngine {

    /// 单次搜索最多扫描的行数（约 300 万行。coros_app 全仓库约 40 万行，留足余量）
    static let maxScannedLines = 3_000_000
    /// 结果数量上限
    static let maxResults = 300

    struct Result {
        var hits: [SearchHit] = []
        var truncated = false
        var scannedLines = 0
    }

    /// 预建「行号 → 定义索引」表（1-based；0 = 无归属/顶层）。
    /// defs 需要按行号升序排列。区间后写覆盖先写：嵌套函数的内层定义覆盖外层。
    static func buildLineOwners(file: SourceFile, defs: [Definition]) -> [Int] {
        let n = file.lines.count
        guard n > 0 else { return [] }
        var owners = [Int](repeating: 0, count: n + 1)
        for (idx, d) in defs.enumerated() {
            let lo = max(1, d.line)
            let hi = min(n, d.endLine > 0 ? d.endLine : d.line)
            if hi < lo { continue }
            for i in lo...hi { owners[i] = idx + 1 }   // 下标从 1 开始，0 保留给顶层
        }
        return owners
    }

    /// 纯搜索：输入所有不可变快照 + 查询参数，输出命中结果。
    /// 可在任意线程调用（只读输入，无共享可变状态）。
    static func search(
        files: [SourceFile],
        defsByFile: [String: [Definition]],
        lineOwners: [String: [Int]],
        query rawQuery: String,
        scopeProject: Bool,
        currentFile: String?
    ) -> Result {
        let q = rawQuery.trimmingCharacters(in: .whitespaces)
        var out = Result()
        guard !q.isEmpty else { return out }

        let scopeFiles = scopeProject ? files
            : files.filter { $0.relPath == currentFile }
        var hitKeys = Set<String>()

        func add(_ hit: SearchHit) {
            guard out.hits.count < maxResults else { return }
            if hitKeys.insert(hit.id).inserted { out.hits.append(hit) }
        }

        for f in scopeFiles {
            let defs = defsByFile[f.relPath] ?? []
            let owners = lineOwners[f.relPath] ?? []
            let lines = f.lines
            // 已命中行号（定义名/签名/调用行命中的行不重复加文本命中）
            var claimed = Set<Int>()

            // ① 定义名命中 + 定义内调用行/签名命中
            for d in defs {
                if out.hits.count >= maxResults { break }
                let nameHit = d.name.range(of: q, options: .caseInsensitive) != nil
                let sigHit = d.signature.range(of: q, options: .caseInsensitive) != nil
                if nameHit {
                    add(SearchHit(kind: .definition, definition: d,
                                  line: d.line, code: d.signature))
                    claimed.insert(d.line)
                } else if sigHit {
                    add(SearchHit(kind: .text, definition: d,
                                  line: d.line, code: d.signature))
                    claimed.insert(d.line)
                }
                for site in d.calls
                    where site.code.range(of: q, options: .caseInsensitive) != nil {
                    add(SearchHit(kind: .text, definition: d,
                                  line: site.line, code: site.code))
                    claimed.insert(site.line)
                }
            }

            // ② 全文行命中：单遍扫描 + O(1) 归属 + O(1) 去重
            for (idx, line) in lines.enumerated() {
                out.scannedLines += 1
                if out.scannedLines > maxScannedLines {
                    out.truncated = true
                    break
                }
                guard line.range(of: q, options: .caseInsensitive) != nil else { continue }
                let n = idx + 1
                if claimed.contains(n) { continue }
                let ownerIdx = (n < owners.count) ? owners[n] : 0
                let owner: Definition?
                if ownerIdx > 0, ownerIdx <= defs.count {
                    owner = defs[ownerIdx - 1]
                } else {
                    owner = defs.last   // 顶层代码：归文件最后一个定义（通常是伪顶层块）
                }
                guard let owner else { continue }
                add(SearchHit(kind: .text, definition: owner,
                              line: n, code: line))
                claimed.insert(n)
                if out.hits.count >= maxResults { break }
            }
            if out.truncated { break }
            if out.hits.count >= maxResults { break }
        }
        return out
    }
}