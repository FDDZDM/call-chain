// App —— 渲染进程根组件
// spec 4.1：两栏布局 + 项目树抽屉
// spec 4.3：⌘+点击函数名 → Worker 构建调用图 → SVG 渲染

import { useState, useEffect, useCallback, useRef } from 'react'
import ProjectTree from './components/ProjectTree'
import CodeViewer from './components/CodeViewer'
import CallGraphView from './components/CallGraphView'
import { useAnalyzer } from './hooks/useAnalyzer'
import type { TreeNode } from './types'
import type { Language } from './types/models'

const isMac = navigator.platform.toLowerCase().includes('mac')
const MOD = isMac ? '⌘' : 'Ctrl+'

// 按扩展名判断是否为支持的源文件
const SOURCE_EXTS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'py', 'java', 'kt', 'kts'])
function isSourceFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  return SOURCE_EXTS.has(ext)
}
// 扩展名 → Language
function extToLang(filename: string): Language {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  switch (ext) {
    case 'ts': case 'tsx': return 'typescript'
    case 'js': case 'jsx': case 'mjs': return 'javascript'
    case 'py': return 'python'
    case 'java': return 'java'
    case 'kt': case 'kts': return 'kotlin'
    default: return 'typescript' // fallback
  }
}
// 递归收集所有源文件
function collectSourceFiles(nodes: TreeNode[], acc: { path: string; language: Language }[] = []) {
  for (const n of nodes) {
    if (n.type === 'dir') {
      collectSourceFiles(n.children || [], acc)
    } else if (isSourceFile(n.name)) {
      acc.push({ path: n.path, language: extToLang(n.name) })
    }
  }
  return acc
}

export default function App() {
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [tree, setTree] = useState<TreeNode[] | null>(null)
  const [treeLoading, setTreeLoading] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingFile, setPendingFile] = useState<string | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [isGraphFullscreen, setIsGraphFullscreen] = useState(false)

  const { graph, progress, parseProject, parseFile, resolveSymbolAt, buildGraph, reset } = useAnalyzer()
  const parsingRef = useRef(false)

  // ⌘\ 切换抽屉 / Esc 退出全屏
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        setDrawerOpen((o) => !o)
      }
      if (e.key === 'Escape' && isGraphFullscreen) {
        setIsGraphFullscreen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isGraphFullscreen])

  // 后台批量解析源文件：逐文件读取 + 发给 Worker
  const parseSourceFiles = useCallback(async (root: string, files: { path: string; language: Language }[]) => {
    if (parsingRef.current) return
    parsingRef.current = true
    const BATCH = 20
    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH)
      await Promise.all(batch.map(async (f) => {
        const { content } = await window.callchain.readFile(root, f.path)
        if (content) parseFile(f.path, f.language, content)
      }))
    }
    parsingRef.current = false
  }, [parseFile])

  const openProject = useCallback(async () => {
    setError(null)
    const dir = await window.callchain.openDirectoryDialog()
    if (!dir) return
    setProjectPath(dir)
    reset()
    setTree(null)
    setTreeLoading(true)
    setDrawerOpen(true) // 打开项目后自动展开项目树抽屉
    try {
      const result = (await window.callchain.scanDir(dir)) as TreeNode[]
      setTree(result)
      // 后台解析所有源文件
      const files = collectSourceFiles(result)
      // 先通知Worker要解析的文件总数，用于进度条
      parseProject(files)
      parseSourceFiles(dir, files)
    } catch (err: any) {
      setError(String(err?.message || err))
    } finally {
      setTreeLoading(false)
    }
  }, [reset, parseProject, parseSourceFiles])

  // 点项目树文件打开代码 tab
  const handleOpenFile = useCallback((relPath: string) => {
    setPendingFile(relPath)
  }, [])

  // ⌘+点击 Monaco 里的函数名 → 查找符号 → 构建图
  const handleSymbolClick = useCallback(async (file: string, line: number, col: number) => {
    const symbol = await resolveSymbolAt(file, line, col)
    if (symbol) {
      buildGraph(symbol.id)
      setSelectedNodeId(null)
    } else {
      const parsing = progress.total > 0 && progress.parsed < progress.total
      let hint: string
      if (parsing) {
        hint = `项目正在解析中（${progress.parsed}/${progress.total}），请等待解析完成后再试。`
      } else if (progress.totalFunctions === 0) {
        hint = '项目解析未提取到任何函数符号，可能是代码解析引擎（wasm）加载失败。请检查错误提示。'
      } else {
        hint = `已解析 ${progress.totalFunctions} 个函数。请确保点击在函数名标识符上（而非括号或空格处）。`
      }
      setError(`未找到该位置的函数（${file}:${line}:${col}）。${hint}`)
    }
  }, [resolveSymbolAt, buildGraph, progress])

  // 双击图节点 → 以它为新锚点重建
  const handleReanchor = useCallback((id: string) => {
    buildGraph(id)
    setSelectedNodeId(null)
  }, [buildGraph])

  const isParsing = progress.total > 0 && progress.parsed < progress.total
  // 解析完成后仍显示进度条（展示函数总数），直到生成调用图后隐藏
  const showParseBar = projectPath && progress.total > 0 && !graph

  return (
    <div className="app">
      <TopBar
        projectPath={projectPath}
        drawerOpen={drawerOpen}
        onToggleDrawer={() => setDrawerOpen((o) => !o)}
        onOpenProject={openProject}
      />
      {showParseBar && (
        <ParseProgress parsed={progress.parsed} total={progress.total} totalFunctions={progress.totalFunctions} />
      )}

      <main className="main-area">
        {!projectPath ? (
          <EmptyState onOpen={openProject} error={error} />
        ) : (
          <>
            {drawerOpen && (
              <Drawer
                tree={tree}
                loading={treeLoading}
                onClose={() => setDrawerOpen(false)}
                onOpenFile={handleOpenFile}
              />
            )}
            <div className="code-pane">
              <CodeViewer
                projectPath={projectPath}
                pendingFile={pendingFile}
                onFileConsumed={() => setPendingFile(null)}
                onError={(msg) => setError(msg)}
                onSymbolClick={handleSymbolClick}
              />
            </div>
            <div className="right-pane">
              <div className="graph-pane">
                <CallGraphView
                  graph={graph}
                  selectedId={selectedNodeId}
                  onSelect={setSelectedNodeId}
                  onReanchor={handleReanchor}
                  isParsing={isParsing}
                  isFullscreen={isGraphFullscreen}
                  onToggleFullscreen={() => setIsGraphFullscreen((f) => !f)}
                />
              </div>
              <div className="inspector-pane">
                <InspectorPlaceholder graph={graph} selectedId={selectedNodeId} />
              </div>
            </div>
            {isGraphFullscreen && (
              <div className="graph-fullscreen-overlay">
                <CallGraphView
                  graph={graph}
                  selectedId={selectedNodeId}
                  onSelect={setSelectedNodeId}
                  onReanchor={handleReanchor}
                  isFullscreen
                  onToggleFullscreen={() => setIsGraphFullscreen(false)}
                />
              </div>
            )}
            {error && <div className="toast-error" onClick={() => setError(null)}>{error}</div>}
          </>
        )}
      </main>
    </div>
  )
}

// ── 子组件 ──

function ParseProgress({ parsed, total, totalFunctions }: { parsed: number; total: number; totalFunctions: number }) {
  const pct = total > 0 ? Math.round((parsed / total) * 100) : 0
  const done = parsed >= total
  return (
    <div className={`parse-progress-bar ${done ? 'parse-progress-done' : ''}`}>
      <div className="parse-progress-info">
        <span className="parse-progress-text">
          {done
            ? `解析完成 · 已提取 ${totalFunctions} 个函数符号`
            : `正在解析项目代码… ${parsed}/${total}（已发现 ${totalFunctions} 个函数）`}
        </span>
        <span className="parse-progress-pct">{done ? '✓' : `${pct}%`}</span>
      </div>
      <div className="parse-progress-track">
        <div className="parse-progress-fill" style={{ width: `${done ? 100 : pct}%` }} />
      </div>
    </div>
  )
}

function TopBar({ projectPath, drawerOpen, onToggleDrawer, onOpenProject }: {
  projectPath: string | null
  drawerOpen: boolean
  onToggleDrawer: () => void
  onOpenProject: () => void
}) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          className="icon-btn"
          onClick={onToggleDrawer}
          title={`${MOD}\\ 项目树`}
          style={{ opacity: drawerOpen ? 1 : 0.6 }}
        >☰</button>
        <span className="brand">CallChain</span>
        {projectPath && <span className="path">{projectPath}</span>}
      </div>
      <button className="btn" onClick={onOpenProject}>{MOD}O 打开项目</button>
    </header>
  )
}

function Drawer({ tree, loading, onClose, onOpenFile }: {
  tree: TreeNode[] | null
  loading: boolean
  onClose: () => void
  onOpenFile: (relPath: string) => void
}) {
  return (
    <div className="drawer">
      <div className="drawer-header">
        <span>项目结构</span>
        <button className="icon-btn" onClick={onClose} title="收起">×</button>
      </div>
      <div className="drawer-body">
        {loading && <div className="tree-loading">扫描中…</div>}
        {!loading && tree && <ProjectTree nodes={tree} onOpenFile={onOpenFile} />}
        {!loading && !tree && <div className="tree-empty">无文件</div>}
      </div>
    </div>
  )
}

function EmptyState({ onOpen, error }: { onOpen: () => void; error: string | null }) {
  return (
    <div className="empty">
      <div className="logo">⛓</div>
      <h1>CallChain · 代码调用链查看器</h1>
      <p>{MOD}O 打开一个项目目录，{MOD}+点击函数名查看调用链</p>
      <button className="btn-primary" onClick={onOpen}>打开项目…</button>
      {error && <p className="error">{error}</p>}
    </div>
  )
}

function InspectorPlaceholder({ graph, selectedId }: { graph: any; selectedId: string | null }) {
  if (!graph) {
    return <div className="placeholder"><div className="placeholder-label">详情检查器</div><div className="placeholder-hint">⌘+点击函数名生成调用链</div></div>
  }
  if (!selectedId) {
    return <div className="placeholder"><div className="placeholder-label">详情检查器</div><div className="placeholder-hint">单击图中的节点查看详情</div></div>
  }
  const node = graph.nodes.find((n: any) => n.id === selectedId)
  if (!node) return null
  return (
    <div className="inspector">
      <div className="inspector-head">
        <div className="inspector-name">{node.def.name}</div>
        {node.def.className && <div className="inspector-class">{node.def.className}</div>}
        <div className="inspector-file">{node.def.file}:{node.def.startLine}</div>
      </div>
    </div>
  )
}
