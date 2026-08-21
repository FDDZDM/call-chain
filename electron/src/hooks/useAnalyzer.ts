// useAnalyzer —— Web Worker 通信封装
// 管理 analyzer.worker 的生命周期、解析、图构建
//
// 关键设计：主线程预加载所有 wasm 二进制，通过 postMessage 传给 Worker，
// 避免 Worker 在 file:// / app:// 等受限环境下 fetch wasm 失败。

import { useEffect, useRef, useState, useCallback } from 'react'
import type {
  CallGraph,
  FunctionSymbol,
  WorkerRequest,
  WorkerResponse,
} from '../types/models'
import { WASM_URLS } from '../analyzer/parser'

interface Progress {
  parsed: number
  total: number
  totalFunctions: number
}

export function useAnalyzer() {
  const workerRef = useRef<Worker | null>(null)
  const [graph, setGraph] = useState<CallGraph | null>(null)
  const [progress, setProgress] = useState<Progress>({ parsed: 0, total: 0, totalFunctions: 0 })
  const [error, setError] = useState<string | null>(null)
  // 一次性回调注册（按消息类型）
  const pendingRef = useRef<Map<string, (msg: WorkerResponse) => void>>(new Map())

  useEffect(() => {
    let worker: Worker
    try {
      worker = new Worker(
        new URL('../analyzer/analyzer.worker.ts', import.meta.url),
        { type: 'module' }
      )
    } catch (err) {
      console.error('[useAnalyzer] worker creation failed', err)
      setError('Worker 创建失败：' + String(err))
      return
    }
    workerRef.current = worker

    worker.onerror = (e) => {
      console.error('[useAnalyzer] worker error', e.message, e.filename, e.lineno)
      setError('Worker 错误：' + e.message)
    }

    const onMessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      // 进度更新
      if (msg.type === 'progress') {
        setProgress({ parsed: msg.parsed, total: msg.total, totalFunctions: msg.totalFunctions ?? 0 })
        return
      }
      // 图结果
      if (msg.type === 'graph') {
        setGraph(msg.graph)
        if (msg.error) setError(msg.error)
        // 触发等待中的回调
        const cb = pendingRef.current.get('graph')
        if (cb) { cb(msg); pendingRef.current.delete('graph') }
        return
      }
      // 符号查找结果
      if (msg.type === 'symbolAt') {
        const cb = pendingRef.current.get('symbolAt')
        if (cb) { cb(msg); pendingRef.current.delete('symbolAt') }
        return
      }
      // 错误
      if (msg.type === 'error') {
        setError(msg.message)
      }
    }

    worker.addEventListener('message', onMessage)

    // 主线程预加载所有 wasm 二进制，传给 Worker 避免 Worker 中 fetch 失败
    ;(async () => {
      try {
        const binaries: Record<string, Uint8Array> = {}
        for (const [key, url] of Object.entries(WASM_URLS)) {
          const res = await fetch(url)
          if (!res.ok) throw new Error(`fetch ${key} failed: ${res.status}`)
          binaries[key] = new Uint8Array(await res.arrayBuffer())
        }
        worker.postMessage({ type: 'initWasm', binaries })
      } catch (err) {
        const msg = `WASM 预加载失败：${String(err)}`
        console.error('[useAnalyzer]', msg)
        setError(msg)
      }
    })()

    return () => {
      worker.removeEventListener('message', onMessage)
      worker.terminate()
    }
  }, [])

  const send = useCallback((req: WorkerRequest) => {
    workerRef.current?.postMessage(req)
  }, [])

  // 发送并等待特定响应
  const sendAndWait = useCallback(
    <K extends string, T extends WorkerResponse>(
      req: WorkerRequest,
      key: K,
    ): Promise<T> => {
      return new Promise((resolve) => {
        pendingRef.current.set(key, (msg) => resolve(msg as T))
        send(req)
      })
    },
    [send],
  )

  // 解析单个文件
  const parseFile = useCallback(
    (path: string, language: string, content: string) => {
      send({ type: 'parseFile', path, language: language as any, content })
    },
    [send],
  )

  // 查找指定位置的符号
  const resolveSymbolAt = useCallback(
    (file: string, line: number, col: number): Promise<FunctionSymbol | null> => {
      return sendAndWait<'symbolAt', WorkerResponse>(
        { type: 'resolveSymbolAt', file, line, col },
        'symbolAt',
      ).then((msg) => (msg.type === 'symbolAt' ? msg.symbol : null))
    },
    [sendAndWait],
  )

  // 构建调用图
  const buildGraph = useCallback(
    (anchorId: string, callerDepth = 3, calleeDepth = 3) => {
      setError(null)
      send({ type: 'buildGraph', anchorId, callerDepth, calleeDepth })
    },
    [send],
  )

  // 重置（打开新项目时）
  const reset = useCallback(() => {
    setGraph(null)
    setProgress({ parsed: 0, total: 0, totalFunctions: 0 })
    setError(null)
  }, [])

  // 开始项目解析（设置文件总数）
  const parseProject = useCallback(
    (files: { path: string; language: string }[]) => {
      reset()
      send({ type: 'parseProject', files: files as any })
    },
    [send, reset],
  )

  return { graph, progress, error, parseProject, parseFile, resolveSymbolAt, buildGraph, reset }
}
