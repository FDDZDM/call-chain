// GraphLayout.swift —— 分层布局
// 水平分层：上层=调用者，中间=锚点，下层=被调用者。
// 同一层内按（文件, 行号）排序横向排布并居中；层间距固定。
// 所有坐标都是「世界坐标」，画布负责缩放/平移。

import Foundation

enum GraphLayout {

    static let rowHeight: Double = 110   // 层间距
    static let gap: Double = 20          // 层内节点间距
    static let padding: Double = 60      // 边界留白

    /// 计算节点尺寸与位置，并填充 bounds 与 levels
    static func layout(_ graph: inout CallGraph) {
        let minLevel = graph.nodes.map(\.level).min() ?? 0
        let maxLevel = graph.nodes.map(\.level).max() ?? 0

        // 尺寸估计（名字宽度按等宽近似）
        for i in graph.nodes.indices {
            let n = graph.nodes[i]
            let nameLen = Double(n.def.name.count)
            let sub = "\((n.def.file as NSString).lastPathComponent):\(n.def.line)"
            let subLen = Double(sub.count)
            let w = max(110, min(330, nameLen * 7.6 + 26, subLen * 6.6 + 26))
            graph.nodes[i].width = w
            graph.nodes[i].height = n.def.kind == .topLevel ? 40 : 48
        }

        // 按层分组，层内按 (file, line) 排序
        var byLevel: [Int: [Int]] = [:]   // level -> node 下标
        let order = graph.nodes.indices.sorted {
            graph.nodes[$0].def.file == graph.nodes[$1].def.file
                ? graph.nodes[$0].def.line < graph.nodes[$1].def.line
                : graph.nodes[$0].def.file < graph.nodes[$1].def.file
        }
        for i in order { byLevel[graph.nodes[i].level, default: []].append(i) }

        var minX = Double.greatestFiniteMagnitude
        var maxX = -Double.greatestFiniteMagnitude
        var minY = Double.greatestFiniteMagnitude
        var maxY = -Double.greatestFiniteMagnitude

        for (level, indices) in byLevel {
            let totalWidth = indices.reduce(0.0) {
                $0 + graph.nodes[$1].width + gap
            } - gap
            var x = -totalWidth / 2
            let y = (Double(level - minLevel) + 0.5) * rowHeight
            for idx in indices {
                graph.nodes[idx].y = y
                let halfW = graph.nodes[idx].width / 2
                graph.nodes[idx].x = x + halfW
                x += graph.nodes[idx].width + gap
                minX = min(minX, graph.nodes[idx].x - halfW)
                maxX = max(maxX, graph.nodes[idx].x + halfW)
                minY = min(minY, y - graph.nodes[idx].height / 2)
                maxY = max(maxY, y + graph.nodes[idx].height / 2)
            }
        }
        if graph.nodes.isEmpty {
            graph.bounds = CGRect(x: -200, y: -60, width: 400, height: 120)
        } else {
            graph.bounds = CGRect(x: minX - padding, y: minY - padding,
                                  width: maxX - minX + padding * 2,
                                  height: maxY - minY + padding * 2)
        }
    }
}