// FileScanner.swift —— 目录扫描
// 递归遍历项目目录，跳过构建目录/依赖目录等噪音，按扩展名识别语言，
// 支持文件数与单文件大小上限，保证大仓库也能秒开（轻量优先）。

import Foundation

struct ScanOptions {
    var maxFiles = 4000      // 最多扫描文件数（防止仓库爆炸）
    var maxBytesPerFile = 2_500_000  // 单文件 >2.5MB 跳过（生成物/大资源）
    var maxLinesPerFile = 20_000     // 单文件最多保留行数（超出截断）

    /// 额外要跳过的目录名（逗号分隔，用户可传 --exclude）
    var extraExcludes: Set<String> = []
}

enum FileScanner {
    /// 永远跳过的目录（构建产物/依赖/版本控制/缓存）
    static let defaultExcludedDirs: Set<String> = [
        ".git", ".svn", ".hg", ".build", "build", "out", "dist",
        ".gradle", "node_modules", "Pods", "DerivedData", ".next",
        "vendor", "Vendor", ".venv", "venv", "__pycache__", ".idea", ".vscode",
        "xcuserdata", ".kotlin", ".hermes", ".swiftpm", "target",
        ".cache", "coverage", ".terraform", ".dart_tool",
        "oh_modules", ".ohpm", ".hvigor", "release", "Debug", "Release",
        ".cxx", "cxx", "Pods", ".plugin", ".l10n", "xcarchive",
    ]

    /// 递归扫描目录，返回解析后的源文件列表（已读入内存）
    /// 有 15 秒硬超时：大仓库/巨型构建缓存不应让工具无限等待（轻量优先）
    static func scan(url: URL, options: ScanOptions) -> [SourceFile] {
        let deadline = Date().addingTimeInterval(15)
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(
            at: url,
            includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey],
            options: []   // 隐藏目录由下面显式判断（.skipsHiddenFiles 不跳过隐藏目录）
        ) else { return [] }

        var files: [SourceFile] = []
        // 解析符号链接后再算相对路径（/tmp → /private/tmp 等场景）
        let rootPath = url.resolvingSymlinksInPath().path

        while let element = enumerator.nextObject() as? URL {
            if Date() > deadline { break }   // 硬超时保护

            // 目录名命中排除名单 / 隐藏目录 → 整棵子树跳过
            if element.hasDirectoryPath {
                let dirName = element.lastPathComponent
                if dirName.hasPrefix(".")
                    || defaultExcludedDirs.contains(dirName)
                    || options.extraExcludes.contains(dirName) {
                    enumerator.skipDescendants()
                }
                continue
            }

            // 数量上限
            if files.count >= options.maxFiles { break }

            let ext = element.pathExtension
            guard let language = Language.detect(ext) else { continue }

            // 大小上限
            if let size = (try? element.resourceValues(forKeys: [.fileSizeKey]))?.fileSize,
               size > options.maxBytesPerFile { continue }

            guard let data = try? Data(contentsOf: element, options: .mappedIfSafe),
                  let text = String(data: data, encoding: .utf8) ??
                             String(data: data, encoding: .utf16) else { continue }

            let elementPath = element.resolvingSymlinksInPath().path
            let relPath = elementPath.hasPrefix(rootPath + "/")
                ? String(elementPath.dropFirst(rootPath.count + 1))
                : elementPath
            var lines = text.components(separatedBy: .newlines)
            if lines.count > options.maxLinesPerFile {
                lines = Array(lines.prefix(options.maxLinesPerFile))
            }
            files.append(SourceFile(path: element.path, relPath: relPath,
                                    language: language, lines: lines))
        }
        return files
    }
}