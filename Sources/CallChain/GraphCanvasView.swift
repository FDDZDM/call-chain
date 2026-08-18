// GraphCanvasView.swift —— 交互画布
// 手势：拖拽平移、双指缩放、单击选中节点、双击以节点为中心重建、空白处双击复位。

import SwiftUI

struct GraphCanvasView: View {
    @ObservedObject var store: ProjectStore

    @State private var scale: CGFloat = 1.0
    @State private var pan = CGSize.zero          // 相对画布中心的偏移
    @State private var dragStart: CGPoint?        // 拖动起始位置（判定点击/拖拽）
    @State private var isDragging = false
    @State private var lastDragTranslation = CGSize.zero

    var body: some View {
        GeometryReader { geo in
            let viewSize = geo.size
            Canvas { context, _ in
                guard let graph = store.graph else { return }
                context.translateBy(x: pan.width + viewSize.width / 2,
                                    y: pan.height + viewSize.height / 2)
                context.scaleBy(x: scale, y: scale)
                GraphRenderer.draw(context: &context, size: viewSize,
                                   graph: graph, selectedID: store.selectedNodeID)
            }
            .background(Color.primary.opacity(0.02))
            .contentShape(Rectangle())
            .gesture(dragGesture(viewSize: viewSize))
            .simultaneousGesture(magnifyGesture())
            .onTapGesture(count: 2) { loc in
                if let id = nodeID(at: loc, viewSize: viewSize) {
                    store.anchorDefinition(store.node(id: id)!.def)
                } else {
                    fitGraph(viewSize: viewSize)
                }
            }
            .onAppear { fitGraph(viewSize: viewSize) }
            .onChange(of: store.fitRequestID) { _ in fitGraph(viewSize: viewSize) }
            .onChange(of: store.graph?.nodes.count) { _ in fitGraph(viewSize: viewSize) }
            .overlay(alignment: .topLeading) {
                legendView.padding(10)
            }
            .overlay {
                if store.graph == nil {
                    emptyHint
                }
            }
        }
    }

    // MARK: 手势

    private func dragGesture(viewSize: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                if dragStart == nil { dragStart = value.startLocation }
                guard let start = dragStart else { return }
                let moved = hypot(value.location.x - start.x,
                                  value.location.y - start.y)
                if !isDragging {
                    if moved > 5 {
                        isDragging = true
                        lastDragTranslation = value.translation
                    }
                } else {
                    // 按增量平移，避免累计误差
                    let dx = value.translation.width - lastDragTranslation.width
                    let dy = value.translation.height - lastDragTranslation.height
                    pan.width += dx
                    pan.height += dy
                    lastDragTranslation = value.translation
                }
            }
            .onEnded { value in
                if !isDragging {
                    // 单击：命中节点则选中，空白则取消选中
                    if let id = nodeID(at: value.location, viewSize: viewSize) {
                        store.selectNode(id: id)
                    } else {
                        store.selectedNodeID = nil
                    }
                }
                dragStart = nil
                isDragging = false
            }
    }

    private func magnifyGesture() -> some Gesture {
        MagnifyGesture()
            .onChanged { value in
                let newScale = min(max(scale * value.magnification, 0.25), 4.0)
                // 以画布中心为缩放锚点，保持中心点物体位置
                let ratio = newScale / scale
                pan.width *= ratio
                pan.height *= ratio
                scale = newScale
            }
    }

    // MARK: 坐标换算/命中

    /// 屏幕点 → 世界点
    private func worldPoint(_ loc: CGPoint, viewSize: CGSize) -> CGPoint {
        CGPoint(x: (loc.x - viewSize.width / 2 - pan.width) / scale,
                y: (loc.y - viewSize.height / 2 - pan.height) / scale)
    }

    private func nodeID(at loc: CGPoint, viewSize: CGSize) -> String? {
        guard let graph = store.graph else { return nil }
        let w = worldPoint(loc, viewSize: viewSize)
        return graph.nodes.last { node in
            abs(w.x - node.x) <= node.width / 2 + 6
                && abs(w.y - node.y) <= node.height / 2 + 6
        }?.id
    }

    /// 把图适配进视口
    private func fitGraph(viewSize: CGSize) {
        guard let graph = store.graph, graph.bounds.width > 0 else { return }
        let s = min(viewSize.width / graph.bounds.width,
                    viewSize.height / graph.bounds.height, 2.0) * 0.92
        scale = max(s, 0.1)
        pan = CGSize(width: -graph.bounds.midX * scale,
                     height: -graph.bounds.midY * scale)
    }

    // MARK: 图例/空态

    private var legendView: some View {
        VStack(alignment: .leading, spacing: 4) {
            legendRow("■", Color.accentColor, "查询目标")
            legendRow("■", .orange, "调用者")
            legendRow("■", .teal, "被调用者")
        }
        .font(.system(size: 11))
        .padding(8)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
    }

    private func legendRow(_ mark: String, _ color: Color, _ label: String) -> some View {
        HStack(spacing: 6) {
            Rectangle().fill(color).frame(width: 10, height: 10)
            Text(label).foregroundColor(.secondary)
        }
    }

    private var emptyHint: some View {
        VStack(spacing: 8) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .font(.system(size: 40)).foregroundColor(.secondary)
            Text("在左侧搜索一个函数或语句，或点击文件列表\n即可绘制调用链")
                .font(.system(size: 13))
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
    }
}