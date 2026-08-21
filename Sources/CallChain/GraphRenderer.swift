// GraphRenderer.swift —— 调用链图的绘制（Canvas 共用 + PNG 快照）
// 世界坐标：节点中心 (x, y)，y 向下为正（层级上→下）。
// 边：调用者在下方的节点底部 → 被调用者上方节点顶部（二次贝塞尔曲线）。

import SwiftUI

enum GraphRenderer {

    /// 按层级取颜色：0 锚点=accent，负=调用者(橙)，正=被调用者(青)
    static func levelColor(_ level: Int) -> Color {
        if level == 0 { return Color.accentColor }
        return level < 0 ? .orange : .teal
    }

    /// 绘制整张图（两种画布共用：交互 Canvas 与导出快照）
    static func draw(context: inout GraphicsContext, size: CGSize,
                     graph: CallGraph, selectedID: String?,
                     focusedStatement: StatementFocus? = nil) {
        let nodeById = Dictionary(uniqueKeysWithValues: graph.nodes.map { ($0.id, $0) })

        // ---- 边（先画，垫底） ----
        for edge in graph.edges {
            guard let from = nodeById[edge.from], let to = nodeById[edge.to] else { continue }
            let path = edgePath(from: from, to: to)
            let isFocusedEdge = focusedStatement.map { focus in
                edge.sites.contains { $0.file == focus.file && $0.line == focus.line }
            } ?? false
            context.stroke(path,
                           with: .color(isFocusedEdge
                                       ? Color.accentColor.opacity(0.95)
                                       : Color.primary.opacity(0.28)),
                           style: StrokeStyle(lineWidth: isFocusedEdge ? 3.0 : 1.3,
                                              lineCap: .round, lineJoin: .round))
            // 箭头（自递归环不画）
            if from.id != to.id,
               let arrow = arrowhead(at: path.currentPoint ?? .zero,
                                     direction: to.level > from.level ? .down : .up) {
                context.fill(arrow, with: .color(isFocusedEdge
                             ? Color.accentColor : Color.primary.opacity(0.35)))
            }
        }

        // ---- 节点（后画，盖在边上） ----
        for node in graph.nodes {
            let rect = CGRect(x: node.x - node.width / 2, y: node.y - node.height / 2,
                              width: node.width, height: node.height)
            let color = levelColor(node.level)
            let isSelected = (node.id == selectedID)
            let isKlass = (node.def.kind == .klass)
            let isTop = (node.def.kind == .topLevel)

            // 底
            context.fill(
                RoundedRectangle(cornerRadius: 9, style: .continuous).path(in: rect),
                with: .color(color.opacity(isSelected ? 0.30 : 0.12))
            )
            // 描边（锚点加粗，类虚线，顶层点线）
            var style = StrokeStyle(lineWidth: isSelected ? 2.2 : 1.4,
                                    lineCap: .round, lineJoin: .round)
            if isKlass { style.dash = [5, 3] }
            if isTop { style.dash = [2, 3] }
            context.stroke(
                RoundedRectangle(cornerRadius: 9, style: .continuous).path(in: rect),
                with: .color(color), style: style
            )

            // 名字（第一行）——只链 Text 保型修饰符（multilineTextAlignment 会返回 some View）
            let nameText = Text(node.def.name)
                .font(.system(size: 11.5, weight: isSelected ? .bold : .semibold))
                .foregroundColor(.primary)
            context.draw(nameText, at: CGPoint(x: rect.midX, y: rect.minY + 17),
                         anchor: .center)

            // 位置（第二行，顶层块只显示一行）
            if !isTop {
                let sub = Text("\((node.def.file as NSString).lastPathComponent):\(node.def.line)")
                    .font(.system(size: 9))
                    .foregroundColor(.secondary)
                context.draw(sub, at: CGPoint(x: rect.midX, y: rect.maxY - 8),
                             anchor: .center)
            }
        }
    }

    /// 建边路径：总是从「上层节点」底部到「下层节点」顶部
    private static func edgePath(from: GraphNode, to: GraphNode) -> Path {
        var p = Path()
        let downward = to.level > from.level
        let src = CGPoint(x: from.x, y: from.y + from.height / 2)
        let dst = CGPoint(x: to.x, y: to.y - to.height / 2)
        if from.id == to.id {
            // 自递归：右侧小环
            let c = CGPoint(x: from.x + from.width / 2, y: from.y)
            p.move(to: CGPoint(x: c.x, y: c.y - 10))
            p.addArc(center: CGPoint(x: c.x + 14, y: c.y), radius: 14,
                     startAngle: .degrees(-90), endAngle: .degrees(270),
                     clockwise: false)
            return p
        }
        p.move(to: src)
        let midX = (src.x + dst.x) / 2
        let dy: CGFloat = downward ? 34 : -34
        p.addQuadCurve(to: dst,
                       control: CGPoint(x: midX, y: src.y + dy))
        return p
    }

    /// 箭头（小三角，指向 dst）
    private static func arrowhead(at point: CGPoint, direction: ArrowDir) -> Path? {
        var p = Path()
        let size: CGFloat = 5
        switch direction {
        case .down:
            p.move(to: CGPoint(x: point.x, y: point.y + size))
            p.addLine(to: CGPoint(x: point.x - size / 2, y: point.y - 1))
            p.addLine(to: CGPoint(x: point.x + size / 2, y: point.y - 1))
        case .up:
            p.move(to: CGPoint(x: point.x, y: point.y - size))
            p.addLine(to: CGPoint(x: point.x - size / 2, y: point.y + 1))
            p.addLine(to: CGPoint(x: point.x + size / 2, y: point.y + 1))
        }
        p.closeSubpath()
        return p
    }

    private enum ArrowDir { case up, down }
}

/// 导出快照用的纯渲染视图（无手势），按图包围盒尺寸渲染
struct GraphSnapshotView: View {
    let graph: CallGraph

    var body: some View {
        Canvas { context, size in
            context.translateBy(x: -graph.bounds.minX, y: -graph.bounds.minY)
            GraphRenderer.draw(context: &context, size: size, graph: graph,
                              selectedID: nil)
        }
        .frame(width: max(graph.bounds.width, 200),
               height: max(graph.bounds.height, 120))
    }
}
