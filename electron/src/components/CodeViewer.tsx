// CodeViewer —— Monaco 只读代码查看器 + 多标签
// spec 4.2：只读模式、多标签(LRU 上限 8)、切换 tab 记住滚动位置
// spec 4.3：⌘+点击函数名 → onSymbolClick 回调

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
  /** ⌘+点击函数名回调（file, line, col） */
  onSymbolClick: (file: string, line: number, col: number) => void
}

const MAX_TABS = 8

export default function CodeViewer({ projectPath, pendingFile, onFileConsumed, onError, onSymbolClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeRelPath, setActiveRelPath] = useState<string | null>(null)
  const [modPressed, setModPressed] = useState(false)
  const modPressedRef = useRef(false)
  // 用 ref 保存最新 tabs，避免闭包陈旧
  const tabsRef = useRef<Tab[]>([])
  tabsRef.current = tabs
  const activeRelPathRef = useRef<string | null>(null)
  activeRelPathRef.current = activeRelPath

  // 初始化 Monaco editor（只读）
  useEffect(() => {
    if (!containerRef.current) return
    const editor = monaco.editor.create(containerRef.current, {
      readOnly: true,
      theme: 'vs',
      automaticLayout: true,
      minimap: { enabled: true, maxColumn: 80 },
      fontSize: 13,
      lineHeight: 20,
      fontFamily: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace',
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      tabSize: 2,
      wordWrap: 'off',
      lineNumbers: 'on',
      folding: true,
      smoothScrolling: true,
    })
    editorRef.current = editor

    // 悬停装饰：⌘按下时给鼠标下的单词加下划线
    let hoverDecos: string[] = []
    const clearHover = () => {
      if (hoverDecos.length > 0) hoverDecos = editor.deltaDecorations(hoverDecos, [])
    }

    // spec 4.3：⌘按下时 onMouseMove → 检测单词 → 加 underline 装饰
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
        options: {
          inlineClassName: 'symbol-hover',
        }
      }])
    })

    editor.onMouseLeave(() => { clearHover() })

    // spec 4.3：⌘+点击检测
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

  // 监听修饰键状态，更新光标样式（spec 4.3 按键提示）
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

  // 切换 tab：保存当前 viewState，加载目标 model + viewState
  const switchTab = useCallback((relPath: string) => {
    const editor = editorRef.current
    if (!editor) return
    // 保存当前 tab 的 viewState
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

  // 打开/激活文件
  const openFile = useCallback(async (relPath: string) => {
    // 已打开：激活
    const existing = tabsRef.current.find((t) => t.relPath === relPath)
    if (existing) {
      switchTab(relPath)
      return
    }
    // 读取文件内容
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
      // LRU：超上限关闭最旧
      if (next.length > MAX_TABS) {
        const removed = next.shift()!
        removed.model.dispose()
      }
      return next
    })

    // 切换到新 tab
    const editor = editorRef.current
    if (editor) {
      // 保存当前 viewState
      if (activeRelPath) {
        const cur = tabsRef.current.find((t) => t.relPath === activeRelPath)
        if (cur) cur.viewState = editor.saveViewState()
      }
      editor.setModel(model)
      setActiveRelPath(relPath)
    }
  }, [projectPath, activeRelPath, switchTab, onError])

  // 监听 pendingFile 变化
  useEffect(() => {
    if (!pendingFile) return
    openFile(pendingFile).then(() => onFileConsumed())
  }, [pendingFile, openFile, onFileConsumed])

  // 关闭 tab
  const closeTab = useCallback((relPath: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.relPath === relPath)
      if (idx === -1) return prev
      const removed = prev[idx]
      removed.model.dispose()
      const next = prev.filter((t) => t.relPath !== relPath)
      // 如果关的是当前 tab，切换到相邻
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

  // 始终渲染容器，避免空 tab 时 containerRef 为 null 导致 Monaco 永不初始化。
  // 空状态用 overlay 覆盖在容器上方，而非条件渲染容器本身。
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
