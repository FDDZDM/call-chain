// CodeViewer —— Monaco 只读代码查看器 + 多标签
// 深色主题 · 文件类型图标 · ⌘+点击触发调用链

import { useEffect, useRef, useState, useCallback } from 'react'
import * as monaco from 'monaco-editor'
import '../monaco/setup'
import { detectLanguage } from '../monaco/setup'

interface Tab {
  relPath: string
  name: string
  language: string
  model: monaco.editor.ITextModel
  viewState: monaco.editor.ICodeEditorViewState | null
}

interface Props {
  projectPath: string
  pendingFile: string | null
  onFileConsumed: () => void
  onError: (msg: string) => void
  onSymbolClick: (file: string, line: number, col: number) => void
}

const MAX_TABS = 8

// 文件扩展名 → 图标颜色
function fileIconColor(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const colorMap: Record<string, string> = {
    ts: '#3178c6', tsx: '#3178c6',
    js: '#f7df1e', jsx: '#f7df1e', mjs: '#f7df1e',
    py: '#3776ab',
    java: '#ed8b00',
    kt: '#7f52ff', kts: '#7f52ff',
    swift: '#f05138',
    css: '#264de4',
    html: '#e34c26',
    json: '#cbcb41',
    md: '#519aba',
  }
  return colorMap[ext] || '#8a8f9c'
}

// 文件图标（SVG，带类型色标）
function FileIcon({ filename }: { filename: string }) {
  const color = fileIconColor(filename)
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }} className="tab-file-icon">
      <path d="M3 1.5h7l3 3v10H3V1.5z" stroke={color} strokeWidth="1.1" fill={color + '18'} strokeLinejoin="round"/>
      <path d="M10 1.5v3h3" stroke={color} strokeWidth="1.1" fill="none" strokeLinejoin="round"/>
    </svg>
  )
}

export default function CodeViewer({ projectPath, pendingFile, onFileConsumed, onError, onSymbolClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeRelPath, setActiveRelPath] = useState<string | null>(null)
  const [modPressed, setModPressed] = useState(false)
  const modPressedRef = useRef(false)
  const tabsRef = useRef<Tab[]>([])
  tabsRef.current = tabs
  const activeRelPathRef = useRef<string | null>(null)
  activeRelPathRef.current = activeRelPath

  useEffect(() => {
    if (!containerRef.current) return
    const editor = monaco.editor.create(containerRef.current, {
      readOnly: true,
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: true, maxColumn: 80 },
      fontSize: 13,
      lineHeight: 20,
      fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, monospace',
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      tabSize: 2,
      wordWrap: 'off',
      lineNumbers: 'on',
      folding: true,
      smoothScrolling: true,
      scrollbar: {
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
        useShadows: false,
      },
    })
    editorRef.current = editor

    let hoverDecos: string[] = []
    const clearHover = () => {
      if (hoverDecos.length > 0) hoverDecos = editor.deltaDecorations(hoverDecos, [])
    }

    editor.onMouseMove((e) => {
      if (!modPressedRef.current) { clearHover(); return }
      if (e.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) { clearHover(); return }
      const pos = e.target.position
      if (!pos) { clearHover(); return }
      const model = editor.getModel()
      if (!model) { clearHover(); return }
      const word = model.getWordAtPosition(pos)
      if (!word) { clearHover(); return }
      hoverDecos = editor.deltaDecorations(hoverDecos, [{
        range: new monaco.Range(pos.lineNumber, word.startColumn, pos.lineNumber, word.endColumn),
        options: { inlineClassName: 'symbol-hover' }
      }])
    })

    editor.onMouseLeave(() => { clearHover() })

    editor.onMouseDown((e) => {
      const hasMod = e.event.metaKey || e.event.ctrlKey
      if (!hasMod) return
      if (e.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) return
      const pos = e.target.position
      if (!pos) return
      const file = activeRelPathRef.current
      if (!file) return
      onSymbolClick(file, pos.lineNumber, pos.column)
    })

    return () => {
      editor.dispose()
      tabs.forEach((t) => t.model.dispose())
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) { setModPressed(true); modPressedRef.current = true }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) { setModPressed(false); modPressedRef.current = false }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  const switchTab = useCallback((relPath: string) => {
    const editor = editorRef.current
    if (!editor) return
    if (activeRelPath) {
      const cur = tabsRef.current.find((t) => t.relPath === activeRelPath)
      if (cur) cur.viewState = editor.saveViewState()
    }
    const target = tabsRef.current.find((t) => t.relPath === relPath)
    if (target) {
      editor.setModel(target.model)
      if (target.viewState) editor.restoreViewState(target.viewState)
      setActiveRelPath(relPath)
    }
  }, [activeRelPath])

  const openFile = useCallback(async (relPath: string) => {
    const existing = tabsRef.current.find((t) => t.relPath === relPath)
    if (existing) {
      switchTab(relPath)
      return
    }
    const result = await window.callchain.readFile(projectPath, relPath)
    if (!result.content) {
      onError(`无法读取 ${relPath}（${result.encoding}）`)
      return
    }
    const name = relPath.split('/').pop() || relPath
    const language = detectLanguage(name)
    const model = monaco.editor.createModel(result.content, language)
    const newTab: Tab = { relPath, name, language, model, viewState: null }

    setTabs((prev) => {
      const next = [...prev, newTab]
      if (next.length > MAX_TABS) {
        const removed = next.shift()!
        removed.model.dispose()
      }
      return next
    })

    const editor = editorRef.current
    if (editor) {
      if (activeRelPath) {
        const cur = tabsRef.current.find((t) => t.relPath === activeRelPath)
        if (cur) cur.viewState = editor.saveViewState()
      }
      editor.setModel(model)
      setActiveRelPath(relPath)
    }
  }, [projectPath, activeRelPath, switchTab, onError])

  useEffect(() => {
    if (!pendingFile) return
    openFile(pendingFile).then(() => onFileConsumed())
  }, [pendingFile, openFile, onFileConsumed])

  const closeTab = useCallback((relPath: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.relPath === relPath)
      if (idx === -1) return prev
      const removed = prev[idx]
      removed.model.dispose()
      const next = prev.filter((t) => t.relPath !== relPath)
      if (activeRelPath === relPath) {
        const newActive = next[idx] || next[idx - 1] || null
        if (newActive) {
          editorRef.current?.setModel(newActive.model)
          if (newActive.viewState) editorRef.current?.restoreViewState(newActive.viewState)
          setActiveRelPath(newActive.relPath)
        } else {
          editorRef.current?.setModel(null)
          setActiveRelPath(null)
        }
      }
      return next
    })
  }, [activeRelPath])

  const isEmpty = tabs.length === 0

  return (
    <div className="code-viewer">
      {!isEmpty && (
        <div className="tab-bar">
          {tabs.map((tab) => (
            <div
              key={tab.relPath}
              className={`tab ${tab.relPath === activeRelPath ? 'tab-active' : ''}`}
              onClick={() => switchTab(tab.relPath)}
              title={tab.relPath}
            >
              <FileIcon filename={tab.name} />
              <span className="tab-name">{tab.name}</span>
              <button
                className="tab-close"
                onClick={(e) => { e.stopPropagation(); closeTab(tab.relPath) }}
              >×</button>
            </div>
          ))}
        </div>
      )}
      <div ref={containerRef} className={`monaco-container ${modPressed ? 'mod-active' : ''}`} />
      {modPressed && !isEmpty && (
        <div className="mod-hint">⌘+点击函数名 / 调用名查看调用链</div>
      )}
      {isEmpty && (
        <div className="code-viewer-empty-overlay">
          <div className="placeholder-label">代码查看器</div>
          <div className="placeholder-hint">点击左侧项目树文件打开（⌘\ 显示项目树）</div>
        </div>
      )}
    </div>
  )
}
