// ProjectTree —— 递归渲染项目目录树
// spec 4.1：抽屉内容，点击文件触发打开，目录可折叠

import { useState } from 'react'
import type { TreeNode } from '../types'

interface Props {
  nodes: TreeNode[]
  onOpenFile: (relPath: string) => void
}

export default function ProjectTree({ nodes, onOpenFile }: Props) {
  return (
    <div className="tree">
      <TreeNodes nodes={nodes} depth={0} onOpenFile={onOpenFile} />
    </div>
  )
}

function TreeNodes({ nodes, depth, onOpenFile }: {
  nodes: TreeNode[]
  depth: number
  onOpenFile: (relPath: string) => void
}) {
  return (
    <>
      {nodes.map((node) => (
        <TreeRow key={node.path} node={node} depth={depth} onOpenFile={onOpenFile} />
      ))}
    </>
  )
}

function TreeRow({ node, depth, onOpenFile }: {
  node: TreeNode
  depth: number
  onOpenFile: (relPath: string) => void
}) {
  const [expanded, setExpanded] = useState(depth < 1) // 顶层默认展开

  if (node.type === 'dir') {
    return (
      <div className="tree-dir">
        <button
          className="tree-row tree-row-dir"
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => setExpanded(!expanded)}
        >
          <span className="tree-arrow">{expanded ? '▾' : '▸'}</span>
          <span className="tree-icon">📁</span>
          <span className="tree-name">{node.name}</span>
        </button>
        {expanded && node.children && (
          <TreeNodes nodes={node.children} depth={depth + 1} onOpenFile={onOpenFile} />
        )}
      </div>
    )
  }

  return (
    <button
      className="tree-row tree-row-file"
      style={{ paddingLeft: 8 + depth * 14 + 16 }}
      onClick={() => onOpenFile(node.path)}
      title={node.path}
    >
      <span className="tree-icon">📄</span>
      <span className="tree-name">{node.name}</span>
    </button>
  )
}
