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
// 3. 同层顺序遵循源码调用顺序，让图与程序员的阅读路径一致
// 4. 分析层保留完整节点；只有视图超限时才由 UI 按需聚合

import type {
  CallGraph,
  GraphNode,
  GraphEdge,
  FunctionSymbol,
  CallSite,
  FileParseResult,
  FuncCategory,
} from '../types/models.ts'
import { LIMITS } from '../types/models.ts'

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

const NODE_W = 200
const NODE_H = 48

function compareSites(a: CallSite[], b: CallSite[]): number {
  const left = a[0]
  const right = b[0]
  if (!left) return right ? 1 : 0
  if (!right) return -1
  return left.file.localeCompare(right.file)
    || left.line - right.line
    || left.col - right.col
    || left.calleeName.localeCompare(right.calleeName)
}

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

  // 被调用者严格按调用点出现顺序排列；调用者按定义位置排列。
  // 这个顺序会一直传到 childIds 和图布局，避免重新解析后节点跳动。
  for (const entries of calleesOf.values()) {
    entries.sort((a, b) => compareSites(a.sites, b.sites)
      || a.calleeId.localeCompare(b.calleeId))
  }
  for (const entries of callersOf.values()) {
    entries.sort((a, b) => {
      const left = input.functionsById.get(a.callerId)
      const right = input.functionsById.get(b.callerId)
      return (left?.file ?? '').localeCompare(right?.file ?? '')
        || (left?.startLine ?? 0) - (right?.startLine ?? 0)
        || compareSites(a.sites, b.sites)
        || a.callerId.localeCompare(b.callerId)
    })
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


  // BFS 的 parent 只表示最短面包屑路径，不能丢掉 DAG 中的共享分支。
  // 因此在 level 确定后，用完整有向边重建每个节点的可展开邻居。
  childIdsMap.clear()
  for (const edge of edgesByKey.values()) {
    const fromLevel = levelById.get(edge.from)
    const toLevel = levelById.get(edge.to)
    if (fromLevel === undefined || toLevel === undefined) continue
    if (fromLevel === 0 && toLevel === 1) registerChild(edge.from, edge.to)
    else if (toLevel === 0 && fromLevel === -1) registerChild(edge.to, edge.from)
    else if (fromLevel > 0 && toLevel === fromLevel + 1) registerChild(edge.from, edge.to)
    else if (toLevel < 0 && fromLevel === toLevel - 1) registerChild(edge.to, edge.from)
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

  // ── 构建节点 ──
  const nodes: GraphNode[] = []

  for (const id of visited) {
    const def = input.functionsById.get(id)
    if (!def) continue
    const level = levelById.get(id) ?? 0
    const category = nodeCategories.get(id) ?? 'core'
    const visibleChildIds = childIdsMap.get(id) ?? []
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

  const edgesArr = [...edgesByKey.values()].filter((edge) =>
    visited.has(edge.from) && visited.has(edge.to)
  )

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
