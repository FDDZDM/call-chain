// 共享类型 —— 渲染进程与主进程通过 IPC 交换的数据结构
// 主进程 main.ts 也定义了 TreeNode，这里镜像一份用于渲染进程类型检查

// 目录树节点（来自主进程 fs:scanDir）
export interface TreeNode {
  type: 'dir' | 'file'
  name: string
  path: string  // 相对项目根的路径
  children?: TreeNode[]
}

// 读文件结果（来自主进程 fs:readFile）
export interface ReadFileResult {
  content: string | null
  encoding: string
  error?: string
}
