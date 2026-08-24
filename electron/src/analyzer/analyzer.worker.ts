// src/analyzer/analyzer.worker.ts
// spec 2.1 / 5.3：解析层在 Web Worker 跑，不阻塞 UI
//
// 消息协议见 src/types/models.ts（WorkerRequest / WorkerResponse）

/// <reference lib="webworker" />

import type {
  WorkerRequest,
  WorkerResponse,
  FileParseResult,
  FunctionSymbol,
  CallSite,
} from '@/types/models'
import { parseFile, ensureParserReady, setWasmBinaries } from './parser'
import {
  buildSymbolIndex,
  resolveAllCalls,
  type SymbolIndex,
} from './resolver'
import { buildGraphInput, buildGraph, type GraphInput } from './graphBuilder'

// ── 内部状态 ──

const parseResults = new Map<string, FileParseResult>()
const callsByFile = new Map<string, CallSite[]>()
let expectedTotal = 0
let parsedCount = 0
let totalFunctions = 0
let parserErrorReported = false
let symbolIndex: SymbolIndex | null = null
let graphInput: GraphInput | null = null
let resolvedResults: FileParseResult[] | null = null
let wasmReady = false
const pendingMessages: WorkerRequest[] = []
// 队列处理中标记：避免 flushPending 重入
let processing = false
// 各语言query是否构建成功（用于诊断）
const langQueryStatus = new Map<string, 'ok' | 'failed'>()

const post = (msg: WorkerResponse): void => {
  ;(self as unknown as Worker).postMessage(msg)
}

// 处理队列中等待的消息 - 串行处理，确保顺序正确
async function flushPending(): Promise<void> {
  if (processing) return
  processing = true
  while (pendingMessages.length > 0) {
    const req = pendingMessages.shift()!
    try {
      await handle(req)
    } catch (err: any) {
      console.error('[worker] error handling', req.type, err)
      post({ type: 'error', message: String(err?.message || err) })
    }
  }
  processing = false
}

async function ensureIndicesBuilt(): Promise<void> {
  if (symbolIndex && graphInput && resolvedResults) return
  const results = Array.from(parseResults.values())
  const resolved = resolveAllCalls(results)
  resolvedResults = resolved
  for (const r of resolved) callsByFile.set(r.file, r.calls)
  graphInput = buildGraphInput(resolved)
  symbolIndex = buildSymbolIndex(resolved)

  // 发送诊断信息
  const langCounts = new Map<string, { total: number; funcs: number; errors: number }>()
  for (const r of results) {
    const stat = langCounts.get(r.language) ?? { total: 0, funcs: 0, errors: 0 }
    stat.total++
    stat.funcs += r.functions.length
    if (r.error) stat.errors++
    langCounts.set(r.language, stat)
  }
  console.log('[worker] indices built. per-language stats:',
    Object.fromEntries(Array.from(langCounts.entries()).map(([k, v]) => [k, `${v.funcs} funcs / ${v.total} files (${v.errors} errors)`])))
}

// ── 主入口 ──
async function handle(req: WorkerRequest): Promise<void> {
  if (req.type === 'initWasm') {
    setWasmBinaries(req.binaries)
    wasmReady = true
    console.log('[worker] initWasm received, binaries:', Object.keys(req.binaries))
    try {
      await ensureParserReady()
      console.log('[worker] parser ready, languages loaded successfully')
    } catch (err) {
      console.error('[worker] parser init failed:', err)
    }
    post({ type: 'progress', parsed: 0, total: expectedTotal, totalFunctions: 0 })
    // 用户可能在 wasm 下载完成前已经打开项目。此时 parseProject
    // 和 parseFile 都在队列里，必须由 initWasm 主动启动排空，否则会永久卡在 0/N。
    await flushPending()
    return
  }

  if (!wasmReady) {
    pendingMessages.push(req)
    return
  }

  switch (req.type) {
    case 'parseProject': {
      parseResults.clear()
      callsByFile.clear()
      expectedTotal = req.files.length
      parsedCount = 0
      totalFunctions = 0
      parserErrorReported = false
      symbolIndex = null
      graphInput = null
      resolvedResults = null
      langQueryStatus.clear()
      console.log('[worker] parseProject started, total files:', req.files.length)
      // 按语言分组统计
      const langFileCounts = new Map<string, number>()
      for (const f of req.files) {
        langFileCounts.set(f.language, (langFileCounts.get(f.language) || 0) + 1)
      }
      console.log('[worker] file distribution by language:', Object.fromEntries(langFileCounts))
      post({ type: 'progress', parsed: 0, total: expectedTotal, totalFunctions: 0 })
      // 队列中的parseFile等消息现在可以处理了
      await flushPending()
      return
    }

    case 'parseFile': {
      try {
        await ensureParserReady()
        if (!req.content || req.content.length === 0) {
          // 空内容跳过
          const errorResult: FileParseResult = {
            file: req.path, language: req.language,
            functions: [], calls: [], classes: [], error: 'empty file'
          }
          parseResults.set(req.path, errorResult)
          callsByFile.set(req.path, [])
          parsedCount++
          post({ type: 'fileParsed', result: errorResult })
          post({ type: 'progress', parsed: parsedCount, total: expectedTotal || parsedCount, file: req.path, totalFunctions })
          return
        }
        const result = await parseFile(req.path, req.language, req.content)
        if (result.error) {
          langQueryStatus.set(req.language, 'failed')
          // 第一个错误时输出详细诊断
          if (!parserErrorReported) {
            console.error(`[worker] first parse error in ${req.language} file ${req.path}:`, result.error)
            parserErrorReported = true
            post({ type: 'error', message: `${req.language} 解析失败（${result.error}），该语言的函数将无法被识别。其他语言不受影响。` })
          }
        } else {
          langQueryStatus.set(req.language, 'ok')
        }
        parseResults.set(req.path, result)
        callsByFile.set(req.path, result.calls)
        parsedCount++
        totalFunctions += result.functions.length
        symbolIndex = null
        graphInput = null
        resolvedResults = null
        post({ type: 'fileParsed', result })
        post({
          type: 'progress',
          parsed: parsedCount,
          total: expectedTotal || parsedCount,
          file: req.path,
          totalFunctions,
        })
      } catch (err: any) {
        console.error('[worker] parseFile exception:', req.path, err)
        if (!parserErrorReported) {
          parserErrorReported = true
          post({
            type: 'error',
            message: `代码解析引擎初始化失败：${String(err?.message || err)}`,
          })
        }
        const errorResult: FileParseResult = {
          file: req.path,
          language: req.language,
          functions: [],
          calls: [],
          classes: [],
          error: String(err?.message || err),
        }
        parseResults.set(req.path, errorResult)
        callsByFile.set(req.path, [])
        parsedCount++
        post({ type: 'fileParsed', result: errorResult })
        post({
          type: 'progress',
          parsed: parsedCount,
          total: expectedTotal || parsedCount,
          file: req.path,
          totalFunctions,
        })
      }
      return
    }

    case 'buildGraph': {
      try {
        await ensureParserReady()
        await ensureIndicesBuilt()
        if (totalFunctions === 0) {
          post({ type: 'graph', graph: null, error: '未解析到任何函数符号。如果是 Kotlin/Java 等 JVM 语言项目，可能是 grammar 或 query 不完整。' })
          return
        }
        const graph = buildGraph(
          graphInput!,
          req.anchorId,
          req.callerDepth,
          req.calleeDepth,
        )
        if (!graph) {
          post({
            type: 'graph',
            graph: null,
            error: `anchor function not found: ${req.anchorId}`,
          })
          return
        }
        post({ type: 'graph', graph })
      } catch (err: any) {
        post({ type: 'graph', graph: null, error: String(err?.message || err) })
      }
      return
    }

    case 'resolveSymbolAt': {
      try {
        await ensureParserReady()
        await ensureIndicesBuilt()
        const sym = findSymbolAt(
          symbolIndex!,
          callsByFile,
          req.file,
          req.line,
          req.col,
        )
        post({ type: 'symbolAt', symbol: sym })
      } catch (err) {
        console.error('[worker] resolveSymbolAt error:', err)
        post({ type: 'symbolAt', symbol: null })
      }
      return
    }
  }
}

function findSymbolAt(
  index: SymbolIndex,
  calls: Map<string, CallSite[]>,
  file: string,
  line: number,
  col: number,
): FunctionSymbol | null {
  const fileFuncs = index.byFile.get(file) ?? []
  for (const f of fileFuncs) {
    if (
      f.startLine === line &&
      col >= f.startCol &&
      col < f.startCol + f.name.length
    ) {
      return f
    }
  }
  const fileCalls = calls.get(file) ?? []
  for (const c of fileCalls) {
    if (
      c.line === line &&
      col >= c.col &&
      col < c.col + c.calleeName.length
    ) {
      if (c.resolvedCalleeId) {
        const target = index.byId.get(c.resolvedCalleeId)
        if (target) return target
      }
      const matches = index.byName.get(c.calleeName) ?? []
      if (matches.length >= 1) return matches[0]
      return null
    }
  }
  return null
}

self.onmessage = (e: MessageEvent<WorkerRequest>): void => {
  handle(e.data).catch((err: any) => {
    console.error('[worker] unhandled error:', err)
    post({ type: 'error', message: String(err?.message || err) })
  })
}
