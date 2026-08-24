// App —— 渲染进程根组件
// 深色主题 · 三栏布局 · 紫色品牌色

import { useState, useEffect, useCallback, useRef } from 'react'
import ProjectTree from './components/ProjectTree'
import CodeViewer from './components/CodeViewer'
import CallGraphView from './components/CallGraphView'
import { useAnalyzer } from './hooks/useAnalyzer'
import type { TreeNode } from './types'
import type { Language, GraphNode } from './types/models'

const isMac = navigator.platform.toLowerCase().includes('mac')
const MOD = isMac ? '⌘' : 'Ctrl+'
const OPEN_KEY = isMac ? '⌘O' : 'Ctrl+O'

const SOURCE_EXTS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'py', 'java', 'kt', 'kts', 'swift', 'css', 'html', 'json', 'md'])
function isSourceFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  return SOURCE_EXTS.has(ext)
}
function extToLang(filename: string): Language {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  switch (ext) {
    case 'ts': case 'tsx': return 'typescript'
    case 'js': case 'jsx': case 'mjs': return 'javascript'
    case 'py': return 'python'
    case 'java': return 'java'
    case 'kt': case 'kts': return 'kotlin'
    default: return 'typescript'
  }
}
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

// Logo SVG（紫色品牌标志）
function LogoIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <rect x="14" y="2" width="4" height="28" rx="2" fill="#6c5ce7" />
      <ellipse cx="16" cy="8" rx="10" ry="4" fill="none" stroke="#6c5ce7" strokeWidth="3" />
      <ellipse cx="16" cy="24" rx="10" ry="4" fill="none" stroke="#6c5ce7" strokeWidth="3" />
    </svg>
  )
}

export default function App() {
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [tree, setTree] = useState<TreeNode[] | null>(null)
  const [treeLoading, setTreeLoading] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingFile, setPendingFile] = useState<string | null>(null)
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [isGraphFullscreen, setIsGraphFullscreen] = useState(false)

  const { graph, progress, parseProject, parseFile, resolveSymbolAt, buildGraph, reset } = useAnalyzer()
  const parsingRef = useRef(false)

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
    setDrawerOpen(true)
    try {
      const result = (await window.callchain.scanDir(dir)) as TreeNode[]
      setTree(result)
      const files = collectSourceFiles(result)
      parseProject(files)
      parseSourceFiles(dir, files)
    } catch (err: any) {
      setError(String(err?.message || err))
    } finally {
      setTreeLoading(false)
    }
  }, [reset, parseProject, parseSourceFiles])

  const handleOpenFile = useCallback((relPath: string) => {
    setPendingFile(relPath)
    setActiveFile(relPath)
  }, [])

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

  const handleReanchor = useCallback((id: string) => {
    buildGraph(id)
    setSelectedNodeId(null)
  }, [buildGraph])

  // 点击图节点 → 选中并在详情面板展示
  const handleSelectNode = useCallback((id: string | null) => {
    setSelectedNodeId(id)
  }, [])

  const isParsing = progress.total > 0 && progress.parsed < progress.total
  const showParseBar = projectPath && progress.total > 0 && (isParsing || !graph)

  // 路径缩短显示
  const shortProjectPath = projectPath
    ? (projectPath.includes('/') ? '~/' + projectPath.split('/').slice(-2).join('/') : projectPath)
    : ''

  return (
    <div className="app">
      <TopBar
        projectPath={shortProjectPath}
        onOpenProject={openProject}
        onToggleDrawer={() => setDrawerOpen((o) => !o)}
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
              <Sidebar
                tree={tree}
                loading={treeLoading}
                activeFile={activeFile}
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
                  onSelect={handleSelectNode}
                  onReanchor={handleReanchor}
                  isParsing={isParsing}
                  isFullscreen={isGraphFullscreen}
                  onToggleFullscreen={() => setIsGraphFullscreen((f) => !f)}
                />
              </div>
              <InspectorPanel
                graph={graph}
                selectedId={selectedNodeId}
                onReanchor={handleReanchor}
                onSelectNode={handleSelectNode}
              />
            </div>
            {isGraphFullscreen && (
              <div className="graph-fullscreen-overlay">
                <CallGraphView
                  graph={graph}
                  selectedId={selectedNodeId}
                  onSelect={handleSelectNode}
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
  const done = parsed >= total
  const pct = total > 0 ? Math.round((parsed / total) * 100) : 0
  return (
    <div className={`parse-progress-bar ${done ? 'parse-progress-done' : ''}`} style={{ position: 'relative' }}>
      <div className="parse-progress-info">
        {done ? (
          <>
            <span className="parse-progress-check">✓</span>
            <span className="parse-progress-text">解析完成 · 已提取 {totalFunctions} 个函数符号</span>
          </>
        ) : (
          <>
            <span className="parse-progress-check" style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid var(--purple)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <span className="parse-progress-text">正在解析项目代码… {parsed}/{total}（已发现 {totalFunctions} 个函数）</span>
          </>
        )}
      </div>
      <div className="parse-progress-track">
        <div className="parse-progress-fill" style={{ width: `${done ? 100 : pct}%` }} />
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

function TopBar({ projectPath, onOpenProject, onToggleDrawer }: {
  projectPath: string | null
  onOpenProject: () => void
  onToggleDrawer: () => void
}) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="icon-btn" onClick={onToggleDrawer} title={`${MOD}\\ 项目树`}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="3" width="14" height="1.5" rx="0.75" fill="currentColor"/><rect x="1" y="7.5" width="14" height="1.5" rx="0.75" fill="currentColor"/><rect x="1" y="12" width="14" height="1.5" rx="0.75" fill="currentColor"/></svg>
        </button>
        <div className="topbar-logo"><LogoIcon size={20} /></div>
        <span className="brand">CallChain</span>
        {projectPath && (
          <>
            <span className="brand-divider" />
            <span className="path">{projectPath}</span>
          </>
        )}
      </div>
      <button className="btn-primary" onClick={onOpenProject}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 3h3l1.5 1.5H12v7H2V3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" fill="none"/></svg>
        打开项目
      </button>
    </header>
  )
}

function Sidebar({ tree, loading, activeFile, onClose, onOpenFile }: {
  tree: TreeNode[] | null
  loading: boolean
  activeFile: string | null
  onClose: () => void
  onOpenFile: (relPath: string) => void
}) {
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-header-title">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M1.5 3.5h5l1.5 1.5h6.5v7.5h-13V3.5z" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round"/></svg>
          项目结构
        </span>
        <button className="sidebar-close" onClick={onClose} title="收起">×</button>
      </div>
      <div className="sidebar-body">
        {loading && <div className="tree-loading">扫描中…</div>}
        {!loading && tree && <ProjectTree nodes={tree} activeFile={activeFile} onOpenFile={onOpenFile} />}
        {!loading && !tree && <div className="tree-empty">无文件</div>}
      </div>
    </div>
  )
}

function EmptyState({ onOpen, error }: { onOpen: () => void; error: string | null }) {
  return (
    <div className="empty">
      <div className="empty-bg">
        <div className="empty-blob empty-blob-1" />
        <div className="empty-blob empty-blob-2" />
        <div className="empty-blob empty-blob-3" />
      </div>
      <div className="empty-content">
        <div className="empty-logo"><LogoIcon size={72} /></div>
        <h1>CallChain</h1>
        <p className="empty-desc">
          代码调用链查看器 — 打开任意项目，<kbd>⌘</kbd>+点击函数名即可可视化调用链
        </p>
        <button className="btn-primary empty-btn" onClick={onOpen}>
          <svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M2 3h3l1.5 1.5H12v7H2V3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" fill="none"/></svg>
          打开项目…
        </button>
        <div className="empty-features">
          <span className="empty-feature">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 3l3.5 3L1 9M7 9h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
            多语言解析
          </span>
          <span className="empty-feature">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="3" cy="6" r="2" fill="none" stroke="currentColor" strokeWidth="1.2"/><circle cx="9" cy="3" r="2" fill="none" stroke="currentColor" strokeWidth="1.2"/><circle cx="9" cy="9" r="2" fill="none" stroke="currentColor" strokeWidth="1.2"/><path d="M4.8 5.2L7.2 3.8M4.8 6.8L7.2 8.2" stroke="currentColor" strokeWidth="1.2"/></svg>
            调用链图
          </span>
          <span className="empty-feature">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1" y="1" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.2"/><path d="M4 4h4M4 6h4M4 8h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
            语句级查询
          </span>
        </div>
        <div className="empty-shortcuts">
          <span>快捷键 <kbd>{OPEN_KEY}</kbd> 打开项目</span>
          <span>·</span>
          <span><kbd>⌘</kbd>+点击函数名查看调用链</span>
        </div>
        {error && <p className="error" style={{ marginTop: 20 }}>{error}</p>}
      </div>
    </div>
  )
}

// ── 节点详情面板（右下区域，替代原来的 InspectorPlaceholder）──
function categoryDotClass(cat: string): string {
  switch (cat) {
    case 'io': return 'dot-io'
    case 'util': return 'dot-util'
    case 'handler': return 'dot-handler'
    case 'thirdparty': return 'dot-thirdparty'
    default: return 'dot-core'
  }
}

function InspectorPanel({ graph, selectedId, onReanchor, onSelectNode }: {
  graph: any
  selectedId: string | null
  onReanchor: (id: string) => void
  onSelectNode: (id: string | null) => void
}) {
  if (!graph) {
    return (
      <div className="inspector-pane">
        <div className="placeholder">
          <div className="placeholder-label">详情检查器</div>
          <div className="placeholder-hint">⌘+点击函数名生成调用链</div>
        </div>
      </div>
    )
  }
  if (!selectedId) {
    // 没有选中节点时，显示锚点信息
    const anchor = graph.anchor
    return (
      <div className="inspector-pane">
        <div className="inspector-head">
          <div className="inspector-name">{anchor.name}</div>
          {anchor.className && <div className="inspector-class">{anchor.className}</div>}
          <div className="inspector-file">{anchor.file}:{anchor.startLine}</div>
        </div>
        <div className="inspector-divider" />
        <div className="inspector-section">
          <div className="inspector-section-title">提示</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.6 }}>
            单击图中节点查看调用详情，双击节点以其为中心重建调用链。
          </div>
        </div>
      </div>
    )
  }

  const node = graph.nodes.find((n: GraphNode) => n.id === selectedId)
  if (!node) {
    return (
      <div className="inspector-pane">
        <div className="placeholder">
          <div className="placeholder-hint">节点未找到</div>
        </div>
      </div>
    )
  }

  const isAgg = node.nodeType === 'aggregate'
  const qualName = (n: GraphNode) => `${n.def.className ? n.def.className + '.' : ''}${n.def.name}`
  const nodeMap = new Map<string, GraphNode>(graph.nodes.map((n: GraphNode) => [n.id, n]))

  // 收集调用者（上游：指向该节点的边的 from 节点）
  const callers: GraphNode[] = []
  const callees: GraphNode[] = []
  for (const e of graph.edges) {
    if (e.to === node.id) {
      const cn = nodeMap.get(e.from)
      if (cn && cn.nodeType === 'function') callers.push(cn)
    }
    if (e.from === node.id) {
      const cn = nodeMap.get(e.to)
      if (cn && cn.nodeType === 'function') callees.push(cn)
    }
  }

  // 清理文档注释
  const cleanDoc = (d: string) =>
    d.replace(/^\/\*\*?/, '').replace(/\*\/$/, '')
      .split('\n').map((l: string) => l.replace(/^\s*\*\s?/, '').trim())
      .filter(Boolean).slice(0, 5).join('\n')
  const doc = isAgg ? null : (node.def.docComment ? cleanDoc(node.def.docComment) : null)

  // 获取与锚点的调用边（调用代码）
  const parentEdge = node.parentId
    ? graph.edges.find((e: any) =>
      (e.from === node.parentId && e.to === node.id) || (e.from === node.id && e.to === node.parentId)
    )
    : null
  const parentNode = node.parentId ? nodeMap.get(node.parentId) : null

  return (
    <div className="inspector-pane" onClick={() => onSelectNode(null)}>
      <div className="inspector" onClick={(e) => e.stopPropagation()}>
        <div className="inspector-head">
          <div className="inspector-name">
            {isAgg ? `🔧 ${node.aggregatedCount} 个工具函数` : qualName(node)}
            {!isAgg && <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: '13px' }}>{node.def.paramSignature}</span>}
          </div>
          {!isAgg && node.def.className && <div className="inspector-class">{node.def.className}</div>}
          {!isAgg && <div className="inspector-file">{node.def.file}:{node.def.startLine}</div>}
        </div>

        {doc && (
          <>
            <div className="inspector-divider" />
            <div className="inspector-section">
              <div className="inspector-doc" style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                {doc}
              </div>
            </div>
          </>
        )}

        {isAgg && node.aggregatedIds && (
          <>
            <div className="inspector-divider" />
            <div className="inspector-section">
              <div className="inspector-section-title">包含的工具函数</div>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.8 }}>
                {node.aggregatedIds
                  .map((mid: string) => { const m = nodeMap.get(mid); return m ? m.def.name : '' })
                  .filter(Boolean).join('、')}
              </div>
            </div>
          </>
        )}

        {callers.length > 0 && (
          <>
            <div className="inspector-divider" />
            <div className="inspector-section">
              <div className="inspector-section-title">调用了</div>
              {callers.map((cn) => (
                <div
                  key={cn.id}
                  className="inspector-item"
                  onClick={() => { onSelectNode(cn.id); onReanchor(cn.id) }}
                >
                  <span className={`inspector-dot ${categoryDotClass(cn.category)}`} />
                  <span className="inspector-item-name">{qualName(cn)}</span>
                  <span className="inspector-item-file">{cn.def.file.split('/').pop()}:{cn.def.startLine}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {callees.length > 0 && (
          <div className="inspector-section">
            <div className="inspector-section-title">被调用</div>
            {callees.map((cn) => (
              <div
                key={cn.id}
                className="inspector-item"
                onClick={() => { onSelectNode(cn.id); onReanchor(cn.id) }}
              >
                <span className={`inspector-dot ${categoryDotClass(cn.category)}`} />
                <span className="inspector-item-name">{qualName(cn)}</span>
                <span className="inspector-item-file">{cn.def.file.split('/').pop()}:{cn.def.startLine}</span>
              </div>
            ))}
          </div>
        )}

        {parentEdge && parentNode && parentEdge.sites?.[0] && (
          <>
            <div className="inspector-divider" />
            <div className="inspector-section">
              <div className="inspector-section-title">
                {node.level > 0 ? `由 ${qualName(parentNode)} 调用` : `调用了 ${qualName(parentNode)}`}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px', fontFamily: 'var(--mono-font)' }}>
                {parentEdge.sites[0].file.split('/').pop()}:{parentEdge.sites[0].line}
              </div>
              {parentEdge.sites[0].code?.trim() && (
                <div style={{
                  fontFamily: 'var(--mono-font)', fontSize: '10px',
                  color: 'var(--orange)', background: 'rgba(255,170,0,0.08)',
                  padding: '6px 8px', borderRadius: '4px',
                  borderLeft: '2px solid var(--orange)',
                  wordBreak: 'break-all', whiteSpace: 'pre-wrap',
                }}>
                  {parentEdge.sites[0].code.trim().slice(0, 150)}
                </div>
              )}
              {parentEdge.sites.length > 1 && (
                <div style={{ fontSize: '10px', color: 'var(--green)', marginTop: '4px' }}>
                  共 {parentEdge.sites.length} 处调用
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
