// ProjectTree —— 递归渲染项目目录树
// 深色主题 · 文件类型色标 · 激活态高亮 · 文件夹箭头折叠

import { useState } from 'react'
import type { TreeNode } from '../types'

interface Props {
  nodes: TreeNode[]
  activeFile: string | null
  onOpenFile: (relPath: string) => void
}

// 目录图标（折叠/展开）
function DirIcon({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0 }}>
      {open ? (
        <path d="M2 5l5 5 5-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M5 2l5 5-5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  )
}

// 文件夹图标
function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      {open ? (
        <path d="M1.5 5.5h13v7h-13v-7zM1.5 5.5l2-2.5h4l1.5 2.5" stroke="#f0a020" strokeWidth="1.2" fill="rgba(240,160,32,0.12)" strokeLinejoin="round"/>
      ) : (
        <path d="M1.5 4.5h5l1.5 1.5h6.5v6.5h-13V4.5z" stroke="#d4a040" strokeWidth="1.2" fill="rgba(240,160,32,0.12)" strokeLinejoin="round"/>
      )}
    </svg>
  )
}

// 文件图标：用一个简单的方形+折角 + 颜色区分
function FileIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() || ''
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
  const color = colorMap[ext] || '#8a8f9c'
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <path d="M3 1.5h7l3 3v10H3V1.5z" stroke={color} strokeWidth="1.1" fill={color + '18'} strokeLinejoin="round"/>
      <path d="M10 1.5v3h3" stroke={color} strokeWidth="1.1" fill="none" strokeLinejoin="round"/>
    </svg>
  )
}

export default function ProjectTree({ nodes, activeFile, onOpenFile }: Props) {
  return (
    <div className="tree">
      <TreeNodes nodes={nodes} depth={0} activeFile={activeFile} onOpenFile={onOpenFile} />
    </div>
  )
}

function TreeNodes({ nodes, depth, activeFile, onOpenFile }: {
  nodes: TreeNode[]
  depth: number
  activeFile: string | null
  onOpenFile: (relPath: string) => void
}) {
  return (
    <>
      {nodes.map((node) => (
        <TreeRow key={node.path} node={node} depth={depth} activeFile={activeFile} onOpenFile={onOpenFile} />
      ))}
    </>
  )
}

function TreeRow({ node, depth, activeFile, onOpenFile }: {
  node: TreeNode
  depth: number
  activeFile: string | null
  onOpenFile: (relPath: string) => void
}) {
  const [expanded, setExpanded] = useState(depth < 1)
  const isActive = activeFile === node.path

  if (node.type === 'dir') {
    return (
      <div className="tree-dir">
        <button
          className="tree-row tree-row-dir"
          style={{ paddingLeft: 8 + depth * 13 }}
          onClick={() => setExpanded(!expanded)}
        >
          <span className="tree-arrow" style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', display: 'inline-flex' }}>
            <DirIcon open={expanded} />
          </span>
          <span className="tree-icon"><FolderIcon open={expanded} /></span>
          <span className="tree-name">{node.name}</span>
        </button>
        {expanded && node.children && (
          <TreeNodes nodes={node.children} depth={depth + 1} activeFile={activeFile} onOpenFile={onOpenFile} />
        )}
      </div>
    )
  }

  return (
    <button
      className={`tree-row tree-row-file ${isActive ? 'tree-row-active' : ''}`}
      style={{ paddingLeft: 8 + depth * 13 + 20 }}
      onClick={() => onOpenFile(node.path)}
      title={node.path}
    >
      <span className="tree-icon"><FileIcon name={node.name} /></span>
      <span className="tree-name">{node.name}</span>
    </button>
  )
}
