// AnalysisSession.swift —— 扫描 + 解析管线（CLI 与 GUI 共用，非 @MainActor）
// 纯计算逻辑，不触碰任何 UI 状态，可在线程池/CLI 中直接调用。

import Foundation

struct AnalysisSession {
    let files: [SourceFile]
    let defs: [Definition]
    let defsByFile: [String: [Definition]]
    let fileIndex: [String: SourceFile]

    static func run(url: URL, options: ScanOptions) -> AnalysisSession {
        let scanned = FileScanner.scan(url: url, options: options)
        var allDefs: [Definition] = []
        var defsByFile: [String: [Definition]] = [:]
        var fileIndex: [String: SourceFile] = [:]
        for file in scanned {
            let defs = Analyzer.analyze(file: file)
            allDefs.append(contentsOf: defs)
            defsByFile[file.relPath] = defs
            fileIndex[file.relPath] = file
        }
        allDefs.sort { ($0.file, $0.line) < ($1.file, $1.line) }
        return AnalysisSession(files: scanned, defs: allDefs,
                               defsByFile: defsByFile, fileIndex: fileIndex)
    }
}