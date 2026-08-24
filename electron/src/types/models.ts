// 核心数据模型 —— spec 第 3 节
// 解析层（Worker）与 UI 层共享的类型

// 支持的源码语言
export type Language = 'typescript' | 'javascript' | 'python' | 'java' | 'kotlin'

// 函数定义（spec 3.1）
export interface FunctionSymbol {
  /** qualified id，区分同名重载（spec 3.2） */
  id: string
  language: Language
  /** 相对项目根的文件路径 */
  file: string
  /** 函数名 */
  name: string
  /** 所属类名（顶层函数为 null） */
  className: string | null
  /** 参数类型签名，如 "(string, Session)" */
  paramSignature: string
  /** 起始行（1-based） */
  startLine: number
  /** 结束行 */
  endLine: number
  /** 起始列 */
  startCol: number
  /** 函数定义上方的 doc 注释（spec 3.5） */
  docComment: string | null
}

// 函数调用点（spec 3.1）
export interface CallSite {
  /** 调用发生的文件 */
  file: string
  /** 调用所在行（1-based） */
  line: number
  /** 列 */
  col: number
  /** 被调用函数名（文本） */
  calleeName: string
  /** 调用所在的外层函数 id（解析后填入，未解析为 null） */
  callerFunctionId: string | null
  /** 该调用点所在行的源码（用于检查器显示） */
  code: string
  /** 绑定到的函数定义 id（解析后填入） */
  resolvedCalleeId: string | null
  /** 解析状态 */
  status: 'resolved' | 'unresolved-ambiguous' | 'unresolved-notfound'
}

// 类定义（Phase 1 仅建立归属）
export interface ClassSymbol {
  id: string
  language: Language
  file: string
  name: string
  startLine: number
}

// 单文件解析结果（spec 5.1 缓存单元）
export interface FileParseResult {
  file: string
  language: Language
  functions: FunctionSymbol[]
  calls: CallSite[]
  classes: ClassSymbol[]
  /** 解析错误（不阻塞整体流程） */
  error?: string
}

// ── 调用图模型 ──

/** 节点类型 */
export type NodeType = 'function' | 'aggregate' | 'thirdparty' | 'passthrough'

/** 函数类型分类（用于颜色编码） */
export type FuncCategory = 'core' | 'io' | 'util' | 'handler' | 'thirdparty'

export interface GraphNode {
  id: string
  def: FunctionSymbol
  /** 0=锚点，>0=被调用者(右)，<0=调用者(左) */
  level: number
  /** 布局后的坐标 */
  x: number
  y: number
  width: number
  height: number
  /** 节点类型 */
  nodeType: NodeType
  /** 函数分类 */
  category: FuncCategory
  /** 聚合节点：被聚合的函数数量 */
  aggregatedCount?: number
  /** 聚合节点：被聚合的函数ID列表 */
  aggregatedIds?: string[]
  /** BFS 父节点 ID（发现该节点的节点） */
  parentId: string | null
  /** BFS 子节点 ID 列表（该节点发现的节点） */
  childIds: string[]
  /** 是否有可展开的子节点 */
  hasChildren: boolean
}

export interface GraphEdge {
  from: string
  to: string
  /** 所有该调用发生的位置 */
  sites: CallSite[]
  /** 边类型：同步/透传 */
  edgeType: 'sync' | 'passthrough'
}

export interface CallGraph {
  anchor: FunctionSymbol
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** 未找到定义的调用点 */
  unresolved: CallSite[]
  /** 布局后的包围盒 */
  bounds: { width: number; height: number }
  /** 是否因达安全上限而截断 */
  isTruncated: boolean
  /** 锚点链路路径（从入口到锚点的最短路径） */
  anchorPath?: string[]
}

// Worker 消息协议
export type WorkerRequest =
  | { type: 'initWasm'; binaries: Record<string, Uint8Array> }
  | { type: 'parseProject'; files: { path: string; language: Language }[] }
  | { type: 'parseFile'; path: string; language: Language; content: string }
  | { type: 'buildGraph'; anchorId: string; callerDepth: number; calleeDepth: number }
  | { type: 'resolveSymbolAt'; file: string; line: number; col: number }

export type WorkerResponse =
  | { type: 'progress'; parsed: number; total: number; file?: string; totalFunctions?: number }
  | { type: 'parseComplete'; results: FileParseResult[] }
  | { type: 'fileParsed'; result: FileParseResult }
  | { type: 'graph'; graph: CallGraph | null; error?: string }
  | { type: 'symbolAt'; symbol: FunctionSymbol | null }
  | { type: 'error'; message: string }

// 安全上限（spec 5.4）
export const LIMITS = {
  MAX_GRAPH_NODES: 300,
  MAX_GRAPH_EDGES: 500,
  MAX_SCAN_FILES: 4000,
  MAX_FILE_SIZE: 2.5 * 1024 * 1024,
  SCAN_TIMEOUT_MS: 15000,
  MAX_SYMBOLS_PER_FILE: 2000,
  /** L3 单链路最大可见节点数 */
  MAX_VISIBLE_NODES: 30,
} as const
