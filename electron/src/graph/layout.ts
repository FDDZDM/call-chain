import type { GraphEdge, GraphNode } from '../types/models'

export const GRAPH_NODE_WIDTH = 224
export const GRAPH_NODE_HEIGHT = 68
export const GRAPH_COLUMN_GAP = 92
export const GRAPH_ROW_GAP = 18

export const GRAPH_COLUMN_STEP = GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP
const ROW_STEP = GRAPH_NODE_HEIGHT + GRAPH_ROW_GAP

export interface GraphLayout {
  positions: Map<string, { x: number; y: number }>
  levels: number[]
  byLevel: Map<number, GraphNode[]>
  bounds: { minX: number; maxX: number; minY: number; maxY: number }
}

/**
 * 以调用方向为主轴布局：调用者在左，锚点居中，被调用者在右。
 * 同层保留 graphBuilder 给出的源码顺序，只用相邻层重心作稳定的交叉减少。
 */
export function computeGraphLayout(nodes: GraphNode[], edges: GraphEdge[]): GraphLayout | null {
  if (nodes.length === 0) return null

  const inputOrder = new Map(nodes.map((node, index) => [node.id, index]))
  const byLevel = new Map<number, GraphNode[]>()
  for (const node of nodes) {
    const column = byLevel.get(node.level) ?? []
    column.push(node)
    byLevel.set(node.level, column)
  }
  const levels = [...byLevel.keys()].sort((a, b) => a - b)

  const neighborsOf = new Map<string, string[]>()
  for (const edge of edges) {
    neighborsOf.set(edge.from, [...(neighborsOf.get(edge.from) ?? []), edge.to])
    neighborsOf.set(edge.to, [...(neighborsOf.get(edge.to) ?? []), edge.from])
  }

  const yPosition = new Map<string, number>()
  const centerColumn = (column: GraphNode[]) => {
    column.forEach((node, index) => {
      yPosition.set(node.id, (index - (column.length - 1) / 2) * ROW_STEP)
    })
  }
  const neighborCenter = (node: GraphNode): number => {
    const positions = (neighborsOf.get(node.id) ?? [])
      .map((id) => yPosition.get(id))
      .filter((value): value is number => value !== undefined)
    return positions.length === 0
      ? 0
      : positions.reduce((sum, value) => sum + value, 0) / positions.length
  }
  const orderColumn = (column: GraphNode[]) => {
    column.sort((left, right) =>
      neighborCenter(left) - neighborCenter(right)
      || (inputOrder.get(left.id) ?? 0) - (inputOrder.get(right.id) ?? 0)
    )
    centerColumn(column)
  }

  centerColumn(byLevel.get(0) ?? [])
  for (const level of levels.filter((value) => value > 0)) {
    const column = byLevel.get(level) ?? []
    centerColumn(column)
    orderColumn(column)
  }
  for (const level of levels.filter((value) => value < 0).reverse()) {
    const column = byLevel.get(level) ?? []
    centerColumn(column)
    orderColumn(column)
  }

  const positions = new Map<string, { x: number; y: number }>()
  for (const node of nodes) {
    positions.set(node.id, {
      x: node.level * GRAPH_COLUMN_STEP - GRAPH_NODE_WIDTH / 2,
      y: yPosition.get(node.id) ?? 0,
    })
  }

  const xs = nodes.map((node) => positions.get(node.id)!.x)
  const ys = nodes.map((node) => positions.get(node.id)!.y)
  return {
    positions,
    levels,
    byLevel,
    bounds: {
      minX: Math.min(...xs) - 28,
      maxX: Math.max(...xs) + GRAPH_NODE_WIDTH + 28,
      minY: Math.min(...ys) - 34,
      maxY: Math.max(...ys) + GRAPH_NODE_HEIGHT + 18,
    },
  }
}

export function graphEdgePath(
  positions: Map<string, { x: number; y: number }>,
  fromId: string,
  toId: string,
): string {
  const from = positions.get(fromId)
  const to = positions.get(toId)
  if (!from || !to) return ''
  const startX = from.x + GRAPH_NODE_WIDTH
  const startY = from.y + GRAPH_NODE_HEIGHT / 2
  const endX = to.x
  const endY = to.y + GRAPH_NODE_HEIGHT / 2
  const controlOffset = Math.max(Math.abs(endX - startX) / 2, 34)
  return `M ${startX} ${startY} C ${startX + controlOffset} ${startY}, ${endX - controlOffset} ${endY}, ${endX} ${endY}`
}
