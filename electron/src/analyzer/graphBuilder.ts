// src/analyzer/graphBuilder.ts
// 链路语义 BFS 构建 CallGraph + 父子树关系
//
// 核心设计（调用链语义）：
// 1. 展开方向与链路方向严格一致：
//    - 锚点（level 0）：childIds = 调用者（向左）+ 被调用者（向右）
//    - 调用者（level < 0）：childIds = 只显示它的调用者（继续向左）
//    - 被调用者（level > 0）：childIds = 只显示它的被调用者（继续向右）
//    这样每次展开只沿链路向外延伸一步，不会展开出旁支，节点线性增长
// 2. level = 真实有向距离（-k 上游 k 层，+k 下游 k 层），非锚点不会混入 level 0
// 3. 函数分类：core/io/util/handler/thirdparty
// 4. 智能聚合：同一父节点同一方向的连续工具函数折叠为 🔧 簇

import type {
  CallGraph,
  GraphNode,
  GraphEdge,
  FunctionSymbol,
  CallSite,
  FileParseResult,
  FuncCategory,
} from '@/types/models'
import { LIMITS } from '@/types/models'

export interface GraphInput {
  functionsById: Map<string, FunctionSymbol>
  callsByCaller: Map<string, CallSite[]>
}

export function buildGraphInput(results: FileParseResult[]): GraphInput {
  const functionsById = new Map<string, FunctionSymbol>()
  const callsByCaller = new Map<string, CallSite[]>()
  for (const r of results) {
    for (const f of r.functions) functionsById.set(f.id, f)
    for (const c of r.calls) {
      if (!c.callerFunctionId) continue
      const arr = callsByCaller.get(c.callerFunctionId) ?? []
      arr.push(c)
      callsByCaller.set(c.callerFunctionId, arr)
    }
  }
  return { functionsById, callsByCaller }
}

// ── 函数分类 ──
const IO_PATTERNS = /^(read|write|fetch|send|save|load|store|query|insert|update|delete|create|remove|get|set|post|put|patch)\w*/i
const HANDLER_PATTERNS = /^(handle|on|render|process|execute|run|start|init|main|serve|listen)\w*/i
const UTIL_PATTERNS = /^(format|parse|convert|transform|map|filter|reduce|sort|compare|validate|check|is|has|can|to|from)\w*/i

export function classifyFunction(def: FunctionSymbol): FuncCategory {
  const name = def.name.toLowerCase()
  if (def.file.includes('node_modules')) return 'thirdparty'
  if (IO_PATTERNS.test(name)) return 'io'
  if (HANDLER_PATTERNS.test(name)) return 'handler'
  if (UTIL_PATTERNS.test(name)) return 'util'
  return 'core'
}

// 分类优先级：展开时新邻居按相关性排序（core > handler > io > util）
export const CATEGORY_RANK: Record<FuncCategory, number> = {
  core: 0,
  handler: 1,
  io: 2,
  thirdparty: 3,
  util: 4,
}

const NODE_W = 200
const NODE_H = 48

export function buildGraph(
  input: GraphInput,
  anchorId: string,
  callerDepth: number,
  calleeDepth: number,
): CallGraph | null {
  const anchor = input.functionsById.get(anchorId)
  if (!anchor) return null

  // 反向索引
  const callersOf = new Map<string, Array<{ callerId: string; sites: CallSite[] }>>()
  const calleesOf = new Map<string, Array<{ calleeId: string; sites: CallSite[] }>>()
  for (const [callerId, calls] of input.callsByCaller) {
    for (const c of calls) {
      if (!c.resolvedCalleeId) continue
      const arr1 = callersOf.get(c.resolvedCalleeId) ?? []
      const ex1 = arr1.find((e) => e.callerId === callerId)
      if (ex1) ex1.sites.push(c)
      else arr1.push({ callerId, sites: [c] })
      callersOf.set(c.resolvedCalleeId, arr1)
      const arr2 = calleesOf.get(callerId) ?? []
      const ex2 = arr2.find((e) => e.calleeId === c.resolvedCalleeId)
      if (ex2) ex2.sites.push(c)
      else arr2.push({ calleeId: c.resolvedCalleeId, sites: [c] })
      calleesOf.set(callerId, arr2)
    }
  }

  // ── 链路语义 BFS ──
  // 规则：
  //   锚点（level 0）双向延伸；level < 0 只向左（找调用者）；level > 0 只向右（找被调用者）
  //   每个节点只会被"第一个发现它的链路"认领，parent 即链路上的前驱
  const visited = new Set<string>()
  const queued = new Set<string>()
  const levelById = new Map<string, number>()
  const parentIdMap = new Map<string, string | null>()
  const childIdsMap = new Map<string, string[]>()
  const edgesByKey = new Map<string, GraphEdge>()
  const queue: Array<{ id: string; level: number; parentId: string | null }> = [
    { id: anchorId, level: 0, parentId: null },
  ]
  let truncated = false

  const addEdge = (from: string, to: string, sites: CallSite[]) => {
    const key = `${from}->${to}`
    const existing = edgesByKey.get(key)
    if (existing) {
      for (const s of sites) if (!existing.sites.includes(s)) existing.sites.push(s)
    } else {
      if (edgesByKey.size >= LIMITS.MAX_GRAPH_EDGES) { truncated = true; return }
      edgesByKey.set(key, { from, to, sites: [...sites], edgeType: 'sync' })
    }
  }

  const registerChild = (parentId: string, childId: string) => {
    const arr = childIdsMap.get(parentId) ?? []
    if (!arr.includes(childId)) arr.push(childId)
    childIdsMap.set(parentId, arr)
  }

  while (queue.length > 0) {
    const { id, level, parentId } = queue.shift()!
    if (visited.has(id)) continue
    if (visited.size >= LIMITS.MAX_GRAPH_NODES) { truncated = true; break }
    visited.add(id)
    queued.delete(id)
    levelById.set(id, level)
    parentIdMap.set(id, parentId)
    if (parentId) registerChild(parentId, id)

    const enqueue = (childId: string, childLevel: number) => {
      if (visited.has(childId) || queued.has(childId)) return
      queued.add(childId)
      queue.push({ id: childId, level: childLevel, parentId: id })
    }

    if (level === 0) {
      // 锚点：双向延伸第一层
      if (calleeDepth > 0) {
        for (const ce of calleesOf.get(id) ?? []) {
          addEdge(id, ce.calleeId, ce.sites)
          enqueue(ce.calleeId, 1)
        }
      }
      if (callerDepth > 0) {
        for (const cr of callersOf.get(id) ?? []) {
          addEdge(cr.callerId, id, cr.sites)
          enqueue(cr.callerId, -1)
        }
      }
    } else if (level > 0) {
      // 被调用者方向：只继续向外找它的被调用者（链路向下游延伸）
      if (level < calleeDepth) {
        for (const ce of calleesOf.get(id) ?? []) {
          addEdge(id, ce.calleeId, ce.sites)
          enqueue(ce.calleeId, level + 1)
        }
      }
    } else {
      // 调用者方向：只继续向外找它的调用者（链路向上游延伸）
      if (level > -callerDepth) {
        for (const cr of callersOf.get(id) ?? []) {
          addEdge(cr.callerId, id, cr.sites)
          enqueue(cr.callerId, level - 1)
        }
      }
    }
  }

  // 收集未解析调用
  const unresolved: CallSite[] = []
  for (const nodeId of visited) {
    const calls = input.callsByCaller.get(nodeId) ?? []
    for (const c of calls) if (c.status !== 'resolved' && !unresolved.includes(c)) unresolved.push(c)
  }

  // ── 函数分类 ──
  const nodeCategories = new Map<string, FuncCategory>()
  for (const id of visited) {
    const def = input.functionsById.get(id)
    if (def) nodeCategories.set(id, classifyFunction(def))
  }

  // ── 智能聚合：同一父节点、同一方向、数量 >= 2 的工具函数折叠 ──
  const aggregatedIds = new Set<string>()
  const aggregateMap = new Map<string, { memberIds: string[]; level: number }>()

  for (const [parentId, childIds] of childIdsMap) {
    // 按方向分组（锚点的子节点有两个方向；其他节点单向）
    const leftUtils: string[] = []
    const rightUtils: string[] = []
    for (const cid of childIds) {
      if (cid === anchorId) continue
      if (nodeCategories.get(cid) !== 'util') continue
      const lvl = levelById.get(cid) ?? 0
      if (lvl < 0) leftUtils.push(cid)
      else if (lvl > 0) rightUtils.push(cid)
    }
    if (leftUtils.length >= 2) {
      const aggId = `agg:${parentId}:L`
      aggregateMap.set(aggId, { memberIds: leftUtils, level: levelById.get(leftUtils[0]) ?? -1 })
      for (const mid of leftUtils) aggregatedIds.add(mid)
    }
    if (rightUtils.length >= 2) {
      const aggId = `agg:${parentId}:R`
      aggregateMap.set(aggId, { memberIds: rightUtils, level: levelById.get(rightUtils[0]) ?? 1 })
      for (const mid of rightUtils) aggregatedIds.add(mid)
    }
  }

  // 成员 → 聚合节点 映射（用于父节点 childIds 重定向与边重定向）
  const memberToAgg = new Map<string, string>()
  for (const [aggId, { memberIds }] of aggregateMap) {
    for (const mid of memberIds) memberToAgg.set(mid, aggId)
  }
  const resolveNodeId = (id: string): string => memberToAgg.get(id) ?? id

  // ── 构建节点 ──
  const nodes: GraphNode[] = []

  for (const id of visited) {
    if (aggregatedIds.has(id)) continue
    const def = input.functionsById.get(id)
    if (!def) continue
    const level = levelById.get(id) ?? 0
    const category = nodeCategories.get(id) ?? 'core'
    // childIds 重定向：聚合成员替换为聚合节点 id，并按相关性排序
    const rawChildIds = childIdsMap.get(id) ?? []
    const mapped = new Set<string>()
    for (const cid of rawChildIds) mapped.add(resolveNodeId(cid))
    const visibleChildIds = [...mapped].sort((a, b) => {
      const na = input.functionsById.get(a), nb = input.functionsById.get(b)
      const ra = na ? CATEGORY_RANK[nodeCategories.get(a) ?? 'core'] : 0
      const rb = nb ? CATEGORY_RANK[nodeCategories.get(b) ?? 'core'] : 0
      return ra - rb
    })
    nodes.push({
      id, def, level,
      x: 0, y: 0,
      width: NODE_W, height: NODE_H,
      nodeType: 'function',
      category,
      parentId: parentIdMap.get(id) ?? null,
      childIds: visibleChildIds,
      hasChildren: visibleChildIds.length > 0,
    })
  }

  // 聚合节点
  for (const [aggId, { memberIds, level }] of aggregateMap) {
    const firstDef = input.functionsById.get(memberIds[0])
    if (!firstDef) continue
    const parentOfFirst = parentIdMap.get(memberIds[0]) ?? null
    nodes.push({
      id: aggId,
      def: firstDef,
      level,
      x: 0, y: 0,
      width: NODE_W, height: NODE_H,
      nodeType: 'aggregate',
      category: 'util',
      aggregatedCount: memberIds.length,
      aggregatedIds: memberIds,
      parentId: parentOfFirst,
      childIds: [],
      hasChildren: false,
    })
  }

  // ── 构建边（重定向到聚合节点）──
  const edgesArr: GraphEdge[] = []
  const edgesByAggKey = new Map<string, GraphEdge>()
  for (const e of edgesByKey.values()) {
    if (!visited.has(e.from) || !visited.has(e.to)) continue
    const from = resolveNodeId(e.from)
    const to = resolveNodeId(e.to)
    if (from === to) continue
    const key = `${from}->${to}`
    const existing = edgesByAggKey.get(key)
    if (existing) {
      for (const s of e.sites) if (!existing.sites.includes(s)) existing.sites.push(s)
    } else {
      const edge: GraphEdge = { from, to, sites: [...e.sites], edgeType: e.edgeType }
      edgesByAggKey.set(key, edge)
      edgesArr.push(edge)
    }
  }

  const bounds = { width: 0, height: 0 }

  return {
    anchor,
    nodes,
    edges: edgesArr,
    unresolved,
    bounds,
    isTruncated: truncated,
  }
}
