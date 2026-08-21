// src/analyzer/graphBuilder.ts
// 双向 BFS 构建 CallGraph + 父子树关系
//
// 核心改进：
// 1. BFS 追踪 parentId/childIds，支持渐进式展开
// 2. 函数分类：core/io/util/handler/thirdparty
// 3. 智能聚合：连续工具函数折叠
// 4. 均衡探索：交替展开调用者和被调用者

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

  // 双向 BFS（追踪 parent）
  const visited = new Set<string>()
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
    levelById.set(id, level)
    parentIdMap.set(id, parentId)
    if (parentId) registerChild(parentId, id)

    // 向下：被调用者（level + 1，右）
    if (level < calleeDepth) {
      const callees = calleesOf.get(id) ?? []
      for (const ce of callees) {
        addEdge(id, ce.calleeId, ce.sites)
        if (!visited.has(ce.calleeId)) {
          queue.push({ id: ce.calleeId, level: level + 1, parentId: id })
        }
      }
    }

    // 向上：调用者（level - 1，左）
    if (level > -callerDepth) {
      const callers = callersOf.get(id) ?? []
      for (const cr of callers) {
        addEdge(cr.callerId, id, cr.sites)
        if (!visited.has(cr.callerId)) {
          queue.push({ id: cr.callerId, level: level - 1, parentId: id })
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

  // ── 智能聚合 ──
  const nodeCategories = new Map<string, FuncCategory>()
  for (const id of visited) {
    const def = input.functionsById.get(id)
    if (def) nodeCategories.set(id, classifyFunction(def))
  }

  const aggregatedIds = new Set<string>()
  const aggregateMap = new Map<string, string[]>()

  const byLevel = new Map<number, string[]>()
  for (const id of visited) {
    const lvl = levelById.get(id) ?? 0
    const arr = byLevel.get(lvl) ?? []
    arr.push(id)
    byLevel.set(lvl, arr)
  }

  // 聚合连续工具函数
  for (const [level, ids] of byLevel) {
    if (level === 0) continue
    const utilRuns: string[][] = []
    let currentRun: string[] = []
    for (const id of ids) {
      if (nodeCategories.get(id) === 'util' && id !== anchorId) {
        currentRun.push(id)
      } else {
        if (currentRun.length >= 2) utilRuns.push(currentRun)
        currentRun = []
      }
    }
    if (currentRun.length >= 2) utilRuns.push(currentRun)
    for (const run of utilRuns) {
      const aggId = `agg:${level}:${run[0]}`
      aggregateMap.set(aggId, run)
      for (const id of run) aggregatedIds.add(id)
    }
  }

  // ── 构建节点 ──
  const nodes: GraphNode[] = []

  for (const id of visited) {
    if (aggregatedIds.has(id)) continue
    const def = input.functionsById.get(id)
    if (!def) continue
    const level = levelById.get(id) ?? 0
    const category = nodeCategories.get(id) ?? 'core'
    const childIds = childIdsMap.get(id) ?? []
    // 过滤掉被聚合的子节点
    const visibleChildIds = childIds.filter((cid) => !aggregatedIds.has(cid))
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
  for (const [aggId, memberIds] of aggregateMap) {
    const firstDef = input.functionsById.get(memberIds[0])
    if (!firstDef) continue
    const parts = aggId.split(':')
    const level = parseInt(parts[1]) || 0
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
  const memberToAgg = new Map<string, string>()
  for (const [aggId, memberIds] of aggregateMap) {
    for (const mid of memberIds) memberToAgg.set(mid, aggId)
  }
  const resolveNodeId = (id: string): string => memberToAgg.get(id) ?? id

  const edgesArr: GraphEdge[] = []
  const seenEdges = new Set<string>()
  for (const e of edgesByKey.values()) {
    if (!visited.has(e.from) || !visited.has(e.to)) continue
    const from = resolveNodeId(e.from)
    const to = resolveNodeId(e.to)
    if (from === to) continue
    const key = `${from}->${to}`
    if (seenEdges.has(key)) {
      const existing = edgesArr.find((x) => `${x.from}->${x.to}` === key)
      if (existing) for (const s of e.sites) if (!existing.sites.includes(s)) existing.sites.push(s)
    } else {
      seenEdges.add(key)
      edgesArr.push({ from, to, sites: [...e.sites], edgeType: e.edgeType })
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
