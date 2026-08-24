// CallGraphView —— 可折叠展开的函数调用链交互图
// 核心设计（基于提示词规范）：
// 1. 渐进式展开：初始只显示锚点+1层邻居，点击节点逐层展开
// 2. 节点指示器：▶(可展开) ▼(已展开) ●(叶子)
// 3. 路径追光：悬停节点高亮从锚点到该节点的完整路径
// 4. 面包屑：显示当前定位上下文
// 5. 节点上限：同时可见不超过30个
// 6. 智能聚合：工具簇自动折叠

import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import type { CallGraph, GraphNode, GraphEdge, CallSite } from '../types/models'

interface Props {
  graph: CallGraph | null
  selectedId: string | null
  onSelect: (id: string | null) => void
  onReanchor: (id: string) => void
  zoomSignal?: number
  fitSignal?: number
  isParsing?: boolean
  isFullscreen?: boolean
  onToggleFullscreen?: () => void
}

const NODE_W = 210
const NODE_H = 50
const COL_W = 280
const ROW_H = 62
const MAX_VISIBLE = 30

interface ViewState { x: number; y: number; scale: number }

// ── 布局：可见节点按 level 分列 + barycenter 排序 ──
function computeLayout(nodes: GraphNode[], edges: GraphEdge[]) {
  if (nodes.length === 0) return null

  const byLevel = new Map<number, GraphNode[]>()
  for (const n of nodes) {
    const arr = byLevel.get(n.level) ?? []
    arr.push(n)
    byLevel.set(n.level, arr)
  }
  const levels = [...byLevel.keys()].sort((a, b) => a - b)

  // 邻接索引（仅可见边）
  const neighborsOf = new Map<string, string[]>()
  for (const e of edges) {
    const a = neighborsOf.get(e.from) ?? []
    a.push(e.to)
    neighborsOf.set(e.from, a)
    const b = neighborsOf.get(e.to) ?? []
    b.push(e.from)
    neighborsOf.set(e.to, b)
  }

  const yPos = new Map<string, number>()
  const avgY = (ids: string[]): number => {
    let sum = 0, cnt = 0
    for (const id of ids) {
      const y = yPos.get(id)
      if (y !== undefined) { sum += y; cnt++ }
    }
    return cnt > 0 ? sum / cnt : 0
  }

  // 锚点列居中
  const col0 = byLevel.get(0) ?? []
  col0.forEach((n, i) => yPos.set(n.id, (i - (col0.length - 1) / 2) * ROW_H))

  // 向右排序
  for (const level of levels) {
    if (level <= 0) continue
    const col = byLevel.get(level)!
    col.forEach((n, i) => yPos.set(n.id, i * ROW_H))
    col.sort((a, b) => avgY(neighborsOf.get(a.id) ?? []) - avgY(neighborsOf.get(b.id) ?? []))
    col.forEach((n, i) => yPos.set(n.id, (i - (col.length - 1) / 2) * ROW_H))
  }

  // 向左排序
  for (let i = levels.length - 1; i >= 0; i--) {
    const level = levels[i]
    if (level >= 0) continue
    const col = byLevel.get(level)!
    col.forEach((n, j) => yPos.set(n.id, j * ROW_H))
    col.sort((a, b) => avgY(neighborsOf.get(a.id) ?? []) - avgY(neighborsOf.get(b.id) ?? []))
    col.forEach((n, j) => yPos.set(n.id, (j - (col.length - 1) / 2) * ROW_H))
  }

  // 赋坐标
  const positions = new Map<string, { x: number; y: number }>()
  for (const n of nodes) {
    const colIdx = levels.indexOf(n.level)
    const x = (colIdx - (levels.length - 1) / 2) * COL_W - NODE_W / 2
    positions.set(n.id, { x, y: yPos.get(n.id) ?? 0 })
  }

  const xs = nodes.map((n) => positions.get(n.id)!.x)
  const ys = nodes.map((n) => positions.get(n.id)!.y)
  return {
    positions,
    levels,
    byLevel,
    bounds: {
      minX: Math.min(...xs) - 20,
      maxX: Math.max(...xs) + NODE_W + 20,
      minY: Math.min(...ys) - 30,
      maxY: Math.max(...ys) + NODE_H + 10,
    },
  }
}

function shortPath(file: string): string {
  const parts = file.split('/')
  return parts.length <= 3 ? file : parts.slice(-3).join('/')
}

function categoryLabel(cat: string): string {
  switch (cat) {
    case 'io': return 'IO'
    case 'util': return '工具'
    case 'handler': return '入口'
    case 'thirdparty': return '三方'
    default: return '核心'
  }
}

export default function CallGraphView({ graph, selectedId, onSelect, onReanchor, zoomSignal, fitSignal, isParsing, isFullscreen, onToggleFullscreen }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const minimapRef = useRef<SVGSVGElement>(null)
  const [view, setView] = useState<ViewState>({ x: 0, y: 0, scale: 1 })
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  /** View 层动态聚合：展开超限时将新增的工具函数子节点折叠为 🔧 簇（parentId → 成员ids） */
  const [dynamicAgg, setDynamicAgg] = useState<Map<string, string[]>>(new Map())
  const [hoveredNode, setHoveredNode] = useState<string | null>(null)
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const tooltipNodeRef = useRef<GraphNode | null>(null)
  const [tooltipVersion, setTooltipVersion] = useState(0) // 用于触发 tooltip 重渲染
  const [expandWarning, setExpandWarning] = useState<string | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; viewX: number; viewY: number } | null>(null)
  const hoverTimerRef = useRef<number | null>(null)

  // 图变化时重置展开状态：锚点默认展开
  useEffect(() => {
    if (graph) {
      setExpandedNodes(new Set([graph.anchor.id]))
      setDynamicAgg(new Map())
      setHoveredNode(null)
      tooltipNodeRef.current = null
    }
  }, [graph?.anchor.id])

  const nodeMap = useMemo(() => {
    return new Map(graph?.nodes.map((n) => [n.id, n]) ?? [])
  }, [graph])

  const dynAggIdOf = (parentId: string) => `dyn-agg:${parentId}`

  // 计算可见节点：锚点 + 已展开节点的子节点（动态聚合成员替换为聚合节点）
  const visibleNodeIds = useMemo(() => {
    if (!graph) return new Set<string>()
    const visible = new Set<string>([graph.anchor.id])
    for (const id of expandedNodes) {
      const node = nodeMap.get(id)
      if (!node) continue
      const aggMembers = dynamicAgg.get(id)
      if (aggMembers) visible.add(dynAggIdOf(id))
      for (const childId of node.childIds) {
        if (aggMembers && aggMembers.includes(childId)) continue
        visible.add(childId)
      }
    }
    return visible
  }, [graph, expandedNodes, nodeMap, dynamicAgg])

  // 动态聚合虚拟节点（🔧 簇）
  const dynamicNodes = useMemo(() => {
    const list: GraphNode[] = []
    for (const [parentId, members] of dynamicAgg) {
      if (!expandedNodes.has(parentId)) continue
      const first = nodeMap.get(members[0])
      if (!first) continue
      list.push({
        id: dynAggIdOf(parentId),
        def: first.def,
        level: first.level,
        x: 0, y: 0,
        width: NODE_W, height: NODE_H,
        nodeType: 'aggregate',
        category: 'util',
        aggregatedCount: members.length,
        aggregatedIds: members,
        parentId,
        childIds: [],
        hasChildren: false,
      })
    }
    return list
  }, [dynamicAgg, expandedNodes, nodeMap])

  const visibleNodes = useMemo(() =>
    (graph?.nodes.filter((n) => visibleNodeIds.has(n.id)) ?? []).concat(dynamicNodes),
    [graph, visibleNodeIds, dynamicNodes]
  )
  const visibleEdges = useMemo(() => {
    if (!graph) return []
    // 动态聚合成员的边重定向到聚合节点
    const memberToDyn = new Map<string, string>()
    for (const [pid, members] of dynamicAgg) {
      for (const m of members) memberToDyn.set(m, dynAggIdOf(pid))
    }
    const out: GraphEdge[] = []
    const seen = new Set<string>()
    for (const e of graph.edges) {
      const from = memberToDyn.get(e.from) ?? e.from
      const to = memberToDyn.get(e.to) ?? e.to
      if (!visibleNodeIds.has(from) || !visibleNodeIds.has(to)) continue
      if (from === to) continue
      const key = `${from}->${to}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ from, to, sites: e.sites, edgeType: e.edgeType })
    }
    return out
  }, [graph, dynamicAgg, visibleNodeIds])

  const layout = useMemo(() => 
    visibleNodes.length > 0 ? computeLayout(visibleNodes, visibleEdges) : null,
    [visibleNodes, visibleEdges]
  )

  // 路径追光：从锚点到悬停节点的路径
  const highlightedPath = useMemo(() => {
    if (!hoveredNode) return null
    const path = new Set<string>()
    let current: string | null = hoveredNode
    while (current) {
      path.add(current)
      const node = nodeMap.get(current)
      current = node?.parentId ?? null
    }
    return path
  }, [hoveredNode, nodeMap])

  // 面包屑路径
  const breadcrumbIds = useMemo(() => {
    const targetId = hoveredNode ?? selectedId
    if (!targetId) return graph ? [graph.anchor.id] : []
    const path: string[] = []
    let current: string | null = targetId
    while (current) {
      path.unshift(current)
      const node = nodeMap.get(current)
      current = node?.parentId ?? null
    }
    return path
  }, [hoveredNode, selectedId, nodeMap, graph])

  const fitView = useCallback(() => {
    if (!layout || !svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const { minX, maxX, minY, maxY } = layout.bounds
    const gw = maxX - minX, gh = maxY - minY
    if (gw <= 0 || gh <= 0) return
    const pad = 40
    const scale = Math.min((rect.width - pad * 2) / gw, (rect.height - pad * 2) / gh, 1.5)
    setView({
      x: rect.width / 2 - ((minX + maxX) / 2) * scale,
      y: rect.height / 2 - ((minY + maxY) / 2) * scale,
      scale,
    })
  }, [layout])

  useEffect(() => { if (layout) fitView() }, [layout, fitView, isFullscreen])
  useEffect(() => { if (zoomSignal !== undefined) setView((v) => ({ ...v, scale: Math.min(v.scale * 1.2, 3) })) }, [zoomSignal])
  useEffect(() => { if (fitSignal !== undefined) fitView() }, [fitSignal, fitView])

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    setView((v) => {
      const ns = Math.max(0.2, Math.min(v.scale * delta, 3))
      const r = ns / v.scale
      return { x: mx - (mx - v.x) * r, y: my - (my - v.y) * r, scale: ns }
    })
  }, [])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    dragRef.current = { startX: e.clientX, startY: e.clientY, viewX: view.x, viewY: view.y }
  }, [view])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const drag = dragRef.current
    if (!drag) return
    setView((v) => ({ ...v, x: drag.viewX + (e.clientX - drag.startX), y: drag.viewY + (e.clientY - drag.startY) }))
  }, [])

  const onMouseUp = useCallback(() => { dragRef.current = null }, [])
  const onDoubleClick = useCallback((e: React.MouseEvent) => { if (e.target === svgRef.current) fitView() }, [fitView])

  // 点击节点：展开/折叠 或 选择
  const handleNodeClick = useCallback((node: GraphNode) => {
    onSelect(node.id)
    if (!node.hasChildren) return
    if (expandedNodes.has(node.id)) {
      // 折叠：移除该节点及所有已展开后代
      const next = new Set(expandedNodes)
      next.delete(node.id)
      const stack = [...node.childIds]
      while (stack.length > 0) {
        const cid = stack.pop()!
        if (next.has(cid)) {
          next.delete(cid)
          const cn = nodeMap.get(cid)
          if (cn) stack.push(...cn.childIds)
        }
      }
      setExpandedNodes(next)
      // 清理该节点的动态聚合
      setDynamicAgg((prev) => {
        if (!prev.has(node.id)) return prev
        const m = new Map(prev)
        m.delete(node.id)
        return m
      })
    } else {
      // 展开：检查节点上限，超限时尝试自动聚合工具函数（软化拦截）
      const newChildren = node.childIds.filter((id) => !visibleNodeIds.has(id))
      if (visibleNodeIds.size + newChildren.length > MAX_VISIBLE) {
        const utils = newChildren.filter((cid) => {
          const cn = nodeMap.get(cid)
          return cn && cn.nodeType === 'function' && cn.category === 'util'
        })
        const others = newChildren.filter((cid) => !utils.includes(cid))
        if (utils.length >= 2 && visibleNodeIds.size + others.length + 1 <= MAX_VISIBLE) {
          // 软聚合：新增工具函数折叠为 🔧 簇，压缩到上限内
          setDynamicAgg((prev) => new Map(prev).set(node.id, utils))
          setExpandedNodes((prev) => new Set(prev).add(node.id))
        } else {
          setExpandWarning(`节点过多（当前 ${visibleNodeIds.size}/${MAX_VISIBLE}），双击该节点可强制展开`)
          setTimeout(() => setExpandWarning(null), 4000)
        }
      } else {
        setExpandedNodes((prev) => new Set(prev).add(node.id))
      }
    }
  }, [nodeMap, onSelect, visibleNodeIds, expandedNodes])

  // Minimap 导航
  const onMinimapClick = useCallback((e: React.MouseEvent) => {
    if (!layout || !minimapRef.current) return
    const rect = minimapRef.current.getBoundingClientRect()
    const mx = (e.clientX - rect.left) / rect.width
    const my = (e.clientY - rect.top) / rect.height
    const { minX, maxX, minY, maxY } = layout.bounds
    const tx = minX + (maxX - minX) * mx
    const ty = minY + (maxY - minY) * my
    const svgRect = svgRef.current?.getBoundingClientRect()
    if (svgRect) {
      setView((v) => ({ x: svgRect.width / 2 - tx * v.scale, y: svgRect.height / 2 - ty * v.scale, scale: v.scale }))
    }
  }, [layout])

  if (!graph || !layout) {
    return (
      <div className="graph-view">
        <div style={{
          background: 'var(--purple)', color: '#fff', fontSize: '11px', padding: '5px 12px',
          textAlign: 'center', fontWeight: 500, flexShrink: 0,
        }}>
          ⌘+点击函数名查看调用链
        </div>
        <div className="graph-empty">
          {isParsing ? (
            <div className="placeholder-hint">正在解析项目代码，完成后即可使用…</div>
          ) : (
            <div className="placeholder-hint">选择代码中的函数以查看调用关系</div>
          )}
        </div>
      </div>
    )
  }

  const { positions, bounds, levels } = layout

  // 列标题
  const levelLabels: Record<number, string> = {}
  for (const l of levels) {
    if (l === 0) levelLabels[l] = '当前函数'
    else if (l < 0) levelLabels[l] = `调用者 ${Math.abs(l)}`
    else levelLabels[l] = `被调用者 ${l}`
  }

  // 边路径
  const edgePath = (fromId: string, toId: string) => {
    const from = positions.get(fromId)!, to = positions.get(toId)!
    const x1 = from.x + NODE_W, y1 = from.y + NODE_H / 2
    const x2 = to.x, y2 = to.y + NODE_H / 2
    const dx = Math.max(Math.abs(x2 - x1) / 2, 30)
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
  }

  // 面包屑项
  const breadcrumbItems = breadcrumbIds.map((id) => {
    const n = nodeMap.get(id)
    if (!n) return '?'
    if (n.nodeType === 'aggregate') return `🔧${n.aggregatedCount}工具`
    return `${n.def.className ? n.def.className + '.' : ''}${n.def.name}`
  })

  return (
    <div className="graph-view">
      {/* 面包屑 */}
      <div className="graph-breadcrumb">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
          <path d="M8 1l2 5h5l-4 3 1.5 5L8 11l-4.5 3L5 9 1 6h5z" stroke="var(--purple)" strokeWidth="1.2" fill="none" strokeLinejoin="round"/>
        </svg>
        <span className="breadcrumb-text">
          {breadcrumbItems.map((item, i) => (
            <span key={i}>
              {i > 0 && <span className="breadcrumb-sep">▸</span>}
              {item}
            </span>
          ))}
        </span>
      </div>

      {/* 工具栏 */}
      <div className="graph-toolbar">
        <button className="graph-tool-btn" onClick={() => fitView()} title="适配视图">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 4V1h3M11 4V1H8M1 8v3h3M11 8v3H8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
          适配
        </button>
        {onToggleFullscreen && (
          <button className="graph-tool-btn" onClick={onToggleFullscreen} title={isFullscreen ? '退出全屏 (Esc)' : '全屏'}>
            {isFullscreen ? (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 1H1v3M8 1h3v3M4 11H1V8M8 11h3V8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 4V1h3M11 4V1H8M1 8v3h3M11 8v3H8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
            )}
            全屏
          </button>
        )}
        <span className="graph-stats">
          {visibleNodes.length} / {graph.nodes.length} 节点 · {visibleEdges.length} 调用
        </span>
      </div>

      {/* 展开警告 */}
      {expandWarning && (
        <div className="graph-expand-warning">{expandWarning}</div>
      )}

      {/* 主图 */}
      <svg
        ref={svgRef}
        className="graph-svg"
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={() => { onMouseUp(); setHoveredNode(null); tooltipNodeRef.current = null; setHoveredEdge(null) }}
        onDoubleClick={onDoubleClick}
        style={{ cursor: dragRef.current ? 'grabbing' : 'grab' }}
      >
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#4a5068" />
          </marker>
          <marker id="arrow-hl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#7c6cf7" />
          </marker>
        </defs>

        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          {/* 列标题 */}
          {levels.map((level) => {
            const x = (levels.indexOf(level) - (levels.length - 1) / 2) * COL_W
            const isAnchor = level === 0
            return (
              <text
                key={`label-${level}`}
                x={x}
                y={bounds.minY - 8}
                textAnchor="middle"
                className={`col-label ${isAnchor ? 'col-label-anchor' : level < 0 ? 'col-label-caller' : 'col-label-callee'}`}
              >
                {levelLabels[level]}
              </text>
            )
          })}

          {/* 边 */}
          {visibleEdges.map((edge: GraphEdge) => {
            const key = `${edge.from}->${edge.to}`
            const isHovered = hoveredEdge === key
            const isOnPath = highlightedPath?.has(edge.from) && highlightedPath?.has(edge.to)
            const isDimmed = highlightedPath && !isOnPath
            const from = positions.get(edge.from), to = positions.get(edge.to)
            if (!from || !to) return null
            const midX = (from.x + NODE_W + to.x) / 2
            const midY = (from.y + to.y) / 2 + NODE_H / 2
            return (
              <g key={key} style={{ opacity: isDimmed ? 0.1 : 1, transition: 'opacity .2s' }}>
                <path
                  d={edgePath(edge.from, edge.to)}
                  className={`edge ${isHovered ? 'edge-hovered' : ''} ${isOnPath ? 'edge-onpath' : ''}`}
                  markerEnd={`url(#${isHovered || isOnPath ? 'arrow-hl' : 'arrow'})`}
                  onMouseEnter={() => setHoveredEdge(key)}
                  onMouseLeave={() => setHoveredEdge(null)}
                />
                {edge.sites.length > 1 && (
                  <g>
                    <rect x={midX - 14} y={midY - 8} width={28} height={16} rx={8} className="edge-badge-bg" />
                    <text x={midX} y={midY + 3} className="edge-badge-text" textAnchor="middle">×{edge.sites.length}</text>
                  </g>
                )}
              </g>
            )
          })}

          {/* 节点 */}
          {visibleNodes.map((node) => {
            const pos = positions.get(node.id)
            if (!pos) return null
            const isAnchor = node.level === 0
            const isCaller = node.level < 0
            const isSelected = selectedId === node.id
            const isHovered = hoveredNode === node.id
            const isOnPath = highlightedPath?.has(node.id)
            const isDimmed = highlightedPath && !isOnPath
            const isExpanded = expandedNodes.has(node.id)
            const isAggregate = node.nodeType === 'aggregate'
            const fileName = shortPath(node.def.file)

            return (
              <g
                key={node.id}
                transform={`translate(${pos.x} ${pos.y})`}
                className={`node ${isAnchor ? 'node-anchor' : ''} ${isCaller ? 'node-caller' : !isAnchor ? 'node-callee' : ''} ${isSelected ? 'node-selected' : ''} ${isHovered ? 'node-hovered' : ''} ${isOnPath ? 'node-onpath' : ''}`}
                onClick={(e) => { e.stopPropagation(); handleNodeClick(node) }}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  if (isAggregate) return
                  const needForce = node.hasChildren && (!expandedNodes.has(node.id) || dynamicAgg.has(node.id))
                  if (needForce) {
                    // 双击未展开/软聚合节点 = 强制展开（绕过节点上限，显示全部子节点）
                    const newCount = node.childIds.filter((id) => !visibleNodeIds.has(id)).length
                    setExpandedNodes((prev) => new Set(prev).add(node.id))
                    // 移除该节点的动态聚合，强制展开时显示全部成员
                    setDynamicAgg((prev) => {
                      if (!prev.has(node.id)) return prev
                      const m = new Map(prev)
                      m.delete(node.id)
                      return m
                    })
                    setExpandWarning(`已强制展开 +${newCount} 个节点（共 ${visibleNodeIds.size + newCount} 个）`)
                    setTimeout(() => setExpandWarning(null), 3000)
                  } else {
                    // 双击已完整展开节点/叶子节点 = 以它为新锚点重建
                    onReanchor(node.id)
                  }
                }}
                onMouseEnter={() => {
                  setHoveredNode(node.id)
                  // 用 ref + 微延迟设置 tooltip，避免与重渲染循环
                  tooltipNodeRef.current = node
                  if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
                  hoverTimerRef.current = window.setTimeout(() => {
                    if (tooltipNodeRef.current === node) setTooltipVersion((v) => v + 1)
                  }, 50)
                }}
                onMouseLeave={() => {
                  // 延迟清除，避免在节点间隙快速切换时抖动
                  if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
                  hoverTimerRef.current = window.setTimeout(() => {
                    setHoveredNode(null)
                    tooltipNodeRef.current = null
                  }, 80)
                }}
                style={{ cursor: 'pointer', opacity: isDimmed ? 0.2 : 1, transition: 'opacity .2s' }}
              >
                <rect width={NODE_W} height={NODE_H} rx={5} className="node-bg" />
                <rect width={3} height={NODE_H} rx={1.5} className={`node-stripe cat-${node.category}`} />
                
                {/* 展开/折叠指示器 */}
                {node.hasChildren ? (
                  <text x={12} y={20} className="node-indicator" onClick={(e) => { e.stopPropagation(); handleNodeClick(node) }}>
                    {isExpanded ? '▼' : '▶'}
                  </text>
                ) : (
                  <text x={12} y={20} className="node-indicator node-indicator-leaf">●</text>
                )}

                {/* 函数名 */}
                <text x={28} y={20} className="node-name">
                  {isAggregate ? `🔧 ${node.aggregatedCount} 个工具函数` : `${node.def.className ? node.def.className + '.' : ''}${node.def.name}`}
                </text>
                {/* 文件:行号 */}
                <text x={28} y={35} className="node-file">{fileName}:{node.def.startLine}</text>
                {/* 类型徽章 */}
                {!isAggregate && (
                  <>
                    <rect x={NODE_W - 48} y={6} width={40} height={13} rx={3} className={`node-badge-bg cat-${node.category}`} />
                    <text x={NODE_W - 28} y={15} className="node-badge-text" textAnchor="middle">
                      {categoryLabel(node.category)}
                    </text>
                  </>
                )}
                {/* 子节点数提示 */}
                {node.hasChildren && !isExpanded && (
                  <text x={NODE_W - 8} y={NODE_H - 6} className="node-child-count" textAnchor="end">
                    {node.childIds.length}→
                  </text>
                )}
              </g>
            )
          })}
        </g>
      </svg>

      {/* Minimap */}
      <div className="graph-minimap">
        <svg ref={minimapRef} className="minimap-svg" onClick={onMinimapClick}>
          {visibleNodes.map((n) => {
            const pos = positions.get(n.id)
            if (!pos) return null
            const mx = ((pos.x - bounds.minX) / (bounds.maxX - bounds.minX)) * 100
            const my = ((pos.y - bounds.minY) / (bounds.maxY - bounds.minY)) * 100
            const isAnchor = n.level === 0
            return <circle key={`mm-${n.id}`} cx={`${mx}%`} cy={`${my}%`} r={isAnchor ? 2.5 : 1.5} className={`minimap-dot ${isAnchor ? 'minimap-dot-anchor' : ''}`} />
          })}
          {(() => {
            const svgRect = svgRef.current?.getBoundingClientRect()
            if (!svgRect) return null
            const vx = ((-view.x / view.scale - bounds.minX) / (bounds.maxX - bounds.minX)) * 100
            const vy = ((-view.y / view.scale - bounds.minY) / (bounds.maxY - bounds.minY)) * 100
            const vw = (svgRect.width / view.scale / (bounds.maxX - bounds.minX)) * 100
            const vh = (svgRect.height / view.scale / (bounds.maxY - bounds.minY)) * 100
            return <rect x={`${vx}%`} y={`${vy}%`} width={`${vw}%`} height={`${vh}%`} className="minimap-viewport" rx={2} />
          })()}
        </svg>
      </div>

      {/* Tooltip（使用 ref + version 触发，避免 mouseEnter/Leave 循环渲染） */}
      {(() => {
        // tooltipVersion 变化时重新读取 ref
        void tooltipVersion
        const node = tooltipNodeRef.current
        if (!node || !hoveredNode) return null
        const pos = positions.get(node.id)
        if (!pos) return null
        const left = view.x + pos.x * view.scale
        const top = view.y + (pos.y + NODE_H) * view.scale + 8
        // 确保不超出视口
        const adjustedLeft = Math.max(8, Math.min(left, (svgRef.current?.clientWidth ?? 9999) - 360))

        const isAgg = node.nodeType === 'aggregate'
        const qualName = (n: GraphNode) => `${n.def.className ? n.def.className + '.' : ''}${n.def.name}`

        // 调用上下文：该节点与链路前驱（parent）之间的调用关系
        let callCtx: { label: string; sites: CallSite[] } | null = null
        if (!isAgg && node.parentId) {
          const parentNode = nodeMap.get(node.parentId)
          if (parentNode && parentNode.nodeType === 'function') {
            // level>0：node 在下游，边 parent→node；level<0：node 在上游，边 node→parent
            const edge = node.level > 0
              ? graph.edges.find((e) => e.from === node.parentId && e.to === node.id)
              : graph.edges.find((e) => e.from === node.id && e.to === node.parentId)
            if (edge && edge.sites.length > 0) {
              callCtx = {
                label: node.level > 0
                  ? `由 ${qualName(parentNode)} 调用`
                  : `调用了 ${qualName(parentNode)}`,
                sites: edge.sites,
              }
            }
          }
        }
        const firstSite = callCtx?.sites[0]

        // 清理文档注释：去掉 /** */ 和行首 *
        const cleanDoc = (d: string) =>
          d.replace(/^\/\*\*?/, '').replace(/\*\/$/, '')
            .split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trim())
            .filter(Boolean).slice(0, 3).join('\n')
        const doc = isAgg ? null : (node.def.docComment ? cleanDoc(node.def.docComment) : null)

        return (
          <div ref={tooltipRef} className="graph-tooltip" style={{ left: adjustedLeft, top }}>
            <div className="tooltip-name">
              {isAgg ? `🔧 ${node.aggregatedCount} 个工具函数` : `${qualName(node)}${node.def.paramSignature}`}
            </div>
            {!isAgg && <div className="tooltip-file">{node.def.file}:{node.def.startLine}</div>}
            {doc && (
              <div className="tooltip-section">
                <div className="tooltip-label">职责</div>
                <div className="tooltip-doc">{doc}</div>
              </div>
            )}
            {callCtx && firstSite && (
              <div className="tooltip-section">
                <div className="tooltip-label">{callCtx.label}</div>
                <div className="tooltip-file">{shortPath(firstSite.file)}:{firstSite.line}</div>
                {firstSite.code.trim() && (
                  <div className="tooltip-code">{firstSite.code.trim().slice(0, 120)}</div>
                )}
                {callCtx.sites.length > 1 && (
                  <div className="tooltip-agg">共 {callCtx.sites.length} 处调用</div>
                )}
              </div>
            )}
            {isAgg && node.aggregatedIds && (
              <div className="tooltip-agg">
                包含：{node.aggregatedIds
                  .map((mid) => { const m = nodeMap.get(mid); return m ? m.def.name : '' })
                  .filter(Boolean).join('、')}
              </div>
            )}
            {node.hasChildren && (
              <div className="tooltip-agg">点击{'\u25B6'}展开 {node.childIds.length} 个子节点</div>
            )}
          </div>
        )
      })()}

      {graph.isTruncated && (
        <div className="graph-truncated">部分节点已截断</div>
      )}
    </div>
  )
}
