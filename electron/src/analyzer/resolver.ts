// src/analyzer/resolver.ts
// spec 3.2：将 CallSite（调用点）绑定到 FunctionSymbol（定义）
//
// 两层查找：
//   1. 同文件作用域内的局部函数
//   2. 全局 name → FunctionSymbol[] 索引
//
// 多候选时的去歧策略（spec 3.2「按参数数量/类型签名打分」在 Phase 1 简化）：
//   - 优先 caller 同类（method 调用同类方法）
//   - 优先 caller 同文件
//   - 仍多于一个 → unresolved-ambiguous（在检查器显式提示）
//
// 注意：CallSite 类型未携带调用方实参个数，故无法做精确的参数数量打分；
// Phase 1 的精度足够区分「同名不同类」的常见情况，重载完全同名同类的极少。

import type { FunctionSymbol, CallSite, FileParseResult } from '@/types/models'

export interface SymbolIndex {
  /** id → FunctionSymbol */
  byId: Map<string, FunctionSymbol>
  /** name → FunctionSymbol[]（同名重载会有多个） */
  byName: Map<string, FunctionSymbol[]>
  /** file → FunctionSymbol[] */
  byFile: Map<string, FunctionSymbol[]>
}

export function buildSymbolIndex(results: FileParseResult[]): SymbolIndex {
  const byId = new Map<string, FunctionSymbol>()
  const byName = new Map<string, FunctionSymbol[]>()
  const byFile = new Map<string, FunctionSymbol[]>()

  for (const r of results) {
    for (const f of r.functions) {
      byId.set(f.id, f)
      const byNameArr = byName.get(f.name) ?? []
      byNameArr.push(f)
      byName.set(f.name, byNameArr)
      const byFileArr = byFile.get(f.file) ?? []
      byFileArr.push(f)
      byFile.set(f.file, byFileArr)
    }
  }

  return { byId, byName, byFile }
}

// 多候选去歧：返回最佳匹配或 null（仍歧义）
function pickBest(
  candidates: FunctionSymbol[],
  caller: FunctionSymbol | null,
): FunctionSymbol | null {
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]

  // 1. caller 在类中 → 优先同类候选
  if (caller?.className) {
    const sameClass = candidates.filter((c) => c.className === caller.className)
    if (sameClass.length === 1) return sameClass[0]
    if (sameClass.length > 1) return null // 同类同名重载，无参个数无法区分
  }

  // 2. caller 是顶层函数 → 优先无类候选
  if (!caller?.className) {
    const top = candidates.filter((c) => !c.className)
    if (top.length === 1) return top[0]
    if (top.length > 1) return null
  }

  // 3. 仍多候选 → 模糊
  return null
}

export interface ResolveResult {
  resolvedCalleeId: string | null
  status: CallSite['status']
}

// 解析单个调用点
export function resolveCall(
  call: CallSite,
  index: SymbolIndex,
  caller: FunctionSymbol | null,
): ResolveResult {
  // 1. 同文件作用域查找（spec 3.2 第 1 层）
  const fileFuncs = index.byFile.get(call.file) ?? []
  const sameFileMatches = fileFuncs.filter((f) => f.name === call.calleeName)
  if (sameFileMatches.length > 0) {
    const best = pickBest(sameFileMatches, caller)
    if (best) return { resolvedCalleeId: best.id, status: 'resolved' }
    if (sameFileMatches.length > 1) {
      // 同文件多候选未去歧 → 模糊
      return { resolvedCalleeId: null, status: 'unresolved-ambiguous' }
    }
  }

  // 2. 全局查找（spec 3.2 第 2 层）
  const globalMatches = index.byName.get(call.calleeName) ?? []
  if (globalMatches.length === 0) {
    return { resolvedCalleeId: null, status: 'unresolved-notfound' }
  }
  const best = pickBest(globalMatches, caller)
  if (best) return { resolvedCalleeId: best.id, status: 'resolved' }

  return { resolvedCalleeId: null, status: 'unresolved-ambiguous' }
}

// 批量解析所有文件的调用点，返回新的 results（calls 字段更新）
export function resolveAllCalls(
  results: FileParseResult[],
  index?: SymbolIndex,
): FileParseResult[] {
  const idx = index ?? buildSymbolIndex(results)
  return results.map((r) => {
    // 该文件的函数 id → symbol，供 calls 反查 caller
    const fileFnById = new Map<string, FunctionSymbol>()
    for (const f of r.functions) fileFnById.set(f.id, f)

    const newCalls = r.calls.map((c): CallSite => {
      const caller = c.callerFunctionId ? fileFnById.get(c.callerFunctionId) ?? null : null
      const res = resolveCall(c, idx, caller)
      return { ...c, resolvedCalleeId: res.resolvedCalleeId, status: res.status }
    })

    return { ...r, calls: newCalls }
  })
}
