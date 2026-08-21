// src/analyzer/parser.ts
// spec 3.1：文件 → 语法树 → 符号
// 职责：加载 tree-sitter wasm + 各语言 grammar，对每个文件解析语法树、执行 query、
// 抽取 FunctionSymbol / CallSite / ClassSymbol，生成 qualified id（spec 3.2）
//
// 容错（spec 6.2）：单文件解析失败不阻塞，记 error 继续
// 离线优先（spec 约束 1）：所有 wasm 通过 Vite `?url` 导入，本地加载

import {
  Parser,
  Language,
  Query,
  type QueryMatch,
  type Node as TSNode,
  type Tree,
} from 'web-tree-sitter'

import type {
  Language as AppLanguage,
  FunctionSymbol,
  CallSite,
  ClassSymbol,
  FileParseResult,
} from '@/types/models'
import { LIMITS } from '@/types/models'

import {
  QUERIES,
  FUNCTION_DEF_NODE_TYPES,
  CLASS_DEF_NODE_TYPES,
  CAPTURE_NAMES,
} from './queries'

// ── wasm URL 导入：Vite 在 dev 模式服务原文件，build 模式拷到 dist/assets ──
import webTreeSitterWasmUrl from 'web-tree-sitter/web-tree-sitter.wasm?url'
import tsWasmUrl from 'tree-sitter-wasm/typescript/tree-sitter-typescript.wasm?url'
import jsWasmUrl from 'tree-sitter-wasm/javascript/tree-sitter-javascript.wasm?url'
import pyWasmUrl from 'tree-sitter-wasm/python/tree-sitter-python.wasm?url'
import javaWasmUrl from 'tree-sitter-wasm/java/tree-sitter-java.wasm?url'
import kotlinWasmUrl from 'tree-sitter-wasm/kotlin/tree-sitter-kotlin.wasm?url'

/** wasm URL 映射，供主线程预加载用 */
export const WASM_URLS: Record<string, string> = {
  webTreeSitter: webTreeSitterWasmUrl,
  typescript: tsWasmUrl,
  javascript: jsWasmUrl,
  python: pyWasmUrl,
  java: javaWasmUrl,
  kotlin: kotlinWasmUrl,
}

/** 预加载的 wasm 二进制数据（Worker 从主线程接收后设置） */
let wasmBinaries: Record<string, Uint8Array> | null = null

/** 由 Worker 在初始化时调用，传入主线程预加载的 wasm 二进制 */
export function setWasmBinaries(binaries: Record<string, Uint8Array>) {
  wasmBinaries = binaries
}

const LANG_KEYS: Record<AppLanguage, string> = {
  typescript: 'typescript',
  javascript: 'javascript',
  python: 'python',
  java: 'java',
  kotlin: 'kotlin',
}

const ALL_LANGS: AppLanguage[] = [
  'typescript',
  'javascript',
  'python',
  'java',
  'kotlin',
]

const loadedLanguages = new Map<AppLanguage, Language>()
const loadedQueries = new Map<AppLanguage, Query>()
let initPromise: Promise<void> | null = null
let initError: string | null = null

/**
 * 加载 wasm：优先用主线程传入的二进制，否则通过 fetch 从 URL 加载。
 * 两种方式都兼容 dev（http://）和生产（app:// / file://）环境。
 */
async function loadWasm(key: string, url: string): Promise<Uint8Array> {
  if (wasmBinaries && wasmBinaries[key]) return wasmBinaries[key]
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch wasm ${key} from ${url}: ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

/**
 * 初始化 tree-sitter runtime + 加载所有 grammar wasm。
 * 幂等：多次调用复用同一个 Promise。失败后允许重试（清 initPromise）。
 */
export async function ensureParserReady(): Promise<void> {
  if (initError) {
    initPromise = null
    initError = null
  }
  if (initPromise) return initPromise
  initPromise = (async () => {
    try {
      // 加载 runtime wasm（二进制方式传入 Emscripten，无需 locateFile fetch）
      const runtimeWasm = await loadWasm('webTreeSitter', webTreeSitterWasmUrl)
      await Parser.init({
        wasmBinary: runtimeWasm,
      })
      for (const lang of ALL_LANGS) {
        const key = LANG_KEYS[lang]
        const url = WASM_URLS[key]
        const langWasm = await loadWasm(key, url)
        const language = await Language.load(langWasm)
        loadedLanguages.set(lang, language)
        try {
          loadedQueries.set(lang, new Query(language, QUERIES[lang]))
        } catch (err: any) {
          console.warn(`[parser] query build failed for ${lang}:`, err?.message || err)
        }
      }
    } catch (err: any) {
      initError = String(err?.message || err)
      initPromise = null
      throw err
    }
  })()
  return initPromise
}

// qualified id 构造（spec 3.2）：lang::file::className::name::paramSignature
export function buildQualifiedId(
  lang: AppLanguage,
  file: string,
  className: string | null,
  name: string,
  paramSignature: string,
): string {
  return `${lang}::${file}::${className || ''}::${name}::${paramSignature}`
}

// 从节点取「名字」子节点文本：优先 name 字段，兜底找 identifier 类子节点
function getNodeName(node: TSNode): string | null {
  const byField = node.childForFieldName('name')
  if (byField) return byField.text
  for (const child of node.namedChildren) {
    const t = child.type
    if (
      t === 'identifier' ||
      t === 'type_identifier' ||
      t === 'simple_identifier' ||
      t === 'property_identifier'
    ) {
      return child.text
    }
  }
  return null
}

// 向上找外层类节点
function findEnclosingClass(node: TSNode, lang: AppLanguage): TSNode | null {
  const types = CLASS_DEF_NODE_TYPES[lang]
  let cur: TSNode | null = node.parent
  while (cur) {
    if (types.has(cur.type)) return cur
    cur = cur.parent
  }
  return null
}

// 向上找外层函数节点
function findEnclosingFunction(node: TSNode, lang: AppLanguage): TSNode | null {
  const types = FUNCTION_DEF_NODE_TYPES[lang]
  let cur: TSNode | null = node.parent
  while (cur) {
    if (types.has(cur.type)) return cur
    cur = cur.parent
  }
  return null
}

// 从 query match 取指定 capture 名的节点
function getCaptureNode(match: QueryMatch, name: string): TSNode | null {
  for (const c of match.captures) {
    if (c.name === name) return c.node
  }
  return null
}

// 只保留包含指定 capture 的 match
function runQueryFiltered(
  query: Query,
  root: TSNode,
  requiredCapture: string,
): QueryMatch[] {
  let all: QueryMatch[]
  try {
    all = query.matches(root)
  } catch {
    return []
  }
  return all.filter((m) => m.captures.some((c) => c.name === requiredCapture))
}

// ── 参数签名提取（spec 3.2：用于区分同名重载）──

// 各语言参数列表所在的字段名 / 节点类型
function findParamsNode(funcNode: TSNode, lang: AppLanguage): TSNode | null {
  // 优先按字段名取
  const fieldCandidates: string[] =
    lang === 'kotlin'
      ? ['function_value_parameters', 'parameters']
      : ['parameters', 'function_value_parameters']
  for (const f of fieldCandidates) {
    const c = funcNode.childForFieldName(f)
    if (c) return c
  }
  // 兜底：按类型名找
  const typeNames = new Set([
    'formal_parameters',
    'parameters',
    'parameter_list',
    'function_value_parameters',
  ])
  for (const child of funcNode.namedChildren) {
    if (typeNames.has(child.type)) return child
  }
  return null
}

function extractSingleParamType(paramNode: TSNode, lang: AppLanguage): string | null {
  if (lang === 'typescript' || lang === 'javascript') {
    // required_parameter / optional_parameter / rest_parameter
    // 都有可选 type_annotation 子节点（rest 也可能有）
    const typeAnnot = paramNode.childForFieldName('type_annotation')
    if (typeAnnot) {
      const text = typeAnnot.text.trim()
      // type_annotation 形如 ": string" / ": Session | null"
      return text.startsWith(':') ? text.slice(1).trim() : text
    }
    // 兜底用参数名（保证签名非空，便于重载区分）
    const pattern =
      paramNode.childForFieldName('pattern') ?? paramNode.childForFieldName('name')
    return pattern ? pattern.text : null
  }

  if (lang === 'python') {
    // typed_parameter / default_parameter 有 annotation 字段
    const typeAnnot = paramNode.childForFieldName('annotation')
    if (typeAnnot) return typeAnnot.text
    // 兜底：identifier 节点自身 / 或取子 identifier
    if (paramNode.type === 'identifier') return paramNode.text
    const name = paramNode.childForFieldName('name')
    if (name) return name.text
    return paramNode.text
  }

  if (lang === 'java') {
    // formal_parameter: type 子节点 + name
    const typeNode = paramNode.childForFieldName('type')
    if (typeNode) return typeNode.text
    return null
  }

  if (lang === 'kotlin') {
    // parameter: simple_identifier ':' type '=' default
    // 树结构里类型在子节点；用文本兜底解析
    const text = paramNode.text
    const colonIdx = text.indexOf(':')
    if (colonIdx >= 0) {
      let rest = text.slice(colonIdx + 1).trim()
      const eqIdx = rest.indexOf('=')
      if (eqIdx >= 0) rest = rest.slice(0, eqIdx).trim()
      return rest || null
    }
    // 无类型，用参数名
    const name = paramNode.childForFieldName('name')
    return name ? name.text : (text.split('=')[0].trim() || null)
  }

  return null
}

function extractParamSignature(funcNode: TSNode, lang: AppLanguage): string {
  const paramsNode = findParamsNode(funcNode, lang)
  if (!paramsNode) return '()'
  const parts: string[] = []
  for (const child of paramsNode.namedChildren) {
    const part = extractSingleParamType(child, lang)
    if (part !== null && part !== '') parts.push(part)
  }
  return `(${parts.join(', ')})`
}

// ── 文档注释提取（spec 3.5：注释优先）──

function extractDocComment(
  funcNode: TSNode,
  lines: string[],
  lang: AppLanguage,
): string | null {
  if (lang === 'python') {
    // Python docstring：函数体 block 第一个 statement 是字符串字面量
    const body = funcNode.childForFieldName('body')
    if (body) {
      const first = body.namedChild(0)
      if (first && first.type === 'expression_statement') {
        const str = first.namedChild(0)
        if (str && (str.type === 'string' || str.type === 'concatenated_string')) {
          return str.text
        }
      }
    }
    return null
  }

  // TS/JS/Java/Kotlin：函数定义上方紧邻的注释块（/** ... */ 或 // 行注释块）
  let row = funcNode.startPosition.row - 1
  const collected: string[] = []
  while (row >= 0 && row < lines.length) {
    const line = lines[row] ?? ''
    const trimmed = line.trim()
    if (trimmed === '') {
      // 空行只在已收集到注释时才尝试继续向上接续块注释
      if (collected.length === 0) {
        row--
        continue
      }
      break
    }
    // 块注释结束（同一行可能是 /** ... */ 单行块）
    if (trimmed.endsWith('*/')) {
      const startIdx = findBlockCommentStart(lines, row)
      if (startIdx >= 0) {
        for (let i = startIdx; i <= row; i++) collected.unshift((lines[i] ?? '').trim())
        return collected.join('\n')
      }
      break
    }
    // 单行注释
    if (trimmed.startsWith('//')) {
      collected.unshift(trimmed)
      row--
      continue
    }
    // 非注释非空 → 终止
    break
  }
  return collected.length > 0 ? collected.join('\n') : null
}

function findBlockCommentStart(lines: string[], endRow: number): number {
  for (let r = endRow; r >= 0; r--) {
    const t = lines[r] ?? ''
    if (t.includes('/*') || t.includes('/**')) return r
  }
  return -1
}

// ── 主入口：解析单个文件 ──

export async function parseFile(
  file: string,
  language: AppLanguage,
  content: string,
): Promise<FileParseResult> {
  await ensureParserReady()

  const result: FileParseResult = {
    file,
    language,
    functions: [],
    calls: [],
    classes: [],
  }

  if (!content) return result

  let parser: Parser | null = null
  let tree: Tree | null = null
  try {
    const lang = loadedLanguages.get(language)
    const query = loadedQueries.get(language)
    if (!lang) {
      result.error = `language not loaded: ${language}`
      return result
    }
    if (!query) {
      result.error = `query not built for: ${language}`
      return result
    }

    parser = new Parser()
    parser.setLanguage(lang)
    tree = parser.parse(content)
    if (!tree) {
      result.error = 'tree-sitter returned null tree'
      return result
    }

    const lines = content.split('\n')
    const root = tree.rootNode

    // 1. 类定义（spec 3.1 ClassDefinition：Phase 1 仅建立归属）
    const classMatches = runQueryFiltered(query, root, CAPTURE_NAMES.CLASS_DEF)
    const classes: ClassSymbol[] = []
    // class node id → ClassSymbol，供 functions 反查 className
    const classNodeToSymbol = new Map<number, ClassSymbol>()
    for (const m of classMatches) {
      const nameNode = getCaptureNode(m, CAPTURE_NAMES.CLASS_NAME)
      const defNode = getCaptureNode(m, CAPTURE_NAMES.CLASS_DEF)
      if (!nameNode || !defNode) continue
      if (classes.length >= LIMITS.MAX_SYMBOLS_PER_FILE) break
      const sym: ClassSymbol = {
        id: `${language}::${file}::${nameNode.text}`,
        language,
        file,
        name: nameNode.text,
        startLine: defNode.startPosition.row + 1,
      }
      classes.push(sym)
      classNodeToSymbol.set(defNode.id, sym)
    }
    result.classes = classes

    // 2. 函数定义（spec 3.2 qualified id）
    const funcMatches = runQueryFiltered(query, root, CAPTURE_NAMES.FUNCTION_DEF)
    const functions: FunctionSymbol[] = []
    // function node id → FunctionSymbol，供 calls 反查 callerFunctionId
    const funcNodeToSymbol = new Map<number, FunctionSymbol>()
    for (const m of funcMatches) {
      const nameNode = getCaptureNode(m, CAPTURE_NAMES.FUNCTION_NAME)
      const defNode = getCaptureNode(m, CAPTURE_NAMES.FUNCTION_DEF)
      if (!nameNode || !defNode) continue
      if (functions.length >= LIMITS.MAX_SYMBOLS_PER_FILE) break

      // 找外层类：通过 parent 链 + classNodeToSymbol 索引
      // findEnclosingClass 已经向上走 parent 链，找到最近的 class 节点
      let className: string | null = null
      const classNode = findEnclosingClass(defNode, language)
      if (classNode) {
        const found = classNodeToSymbol.get(classNode.id)
        if (found) {
          className = found.name
        } else {
          // 类未被 query 抓取（如截断后），从节点兜底取名字
          className = getNodeName(classNode)
        }
      }

      const paramSignature = extractParamSignature(defNode, language)
      const id = buildQualifiedId(language, file, className, nameNode.text, paramSignature)
      const docComment = extractDocComment(defNode, lines, language)

      // startLine/startCol 用 name 节点位置：用户 ⌘+点击函数名时，
      // resolveSymbolAt 能直接命中；endLine 用 def 节点末尾以覆盖整个函数体
      const sym: FunctionSymbol = {
        id,
        language,
        file,
        name: nameNode.text,
        className,
        paramSignature,
        startLine: nameNode.startPosition.row + 1,
        endLine: defNode.endPosition.row + 1,
        startCol: nameNode.startPosition.column + 1,
        docComment,
      }
      functions.push(sym)
      funcNodeToSymbol.set(defNode.id, sym)
    }
    result.functions = functions

    // 3. 调用点（spec 3.1 CallSite）
    const callMatches = runQueryFiltered(query, root, CAPTURE_NAMES.CALL_DEF)
    const calls: CallSite[] = []
    for (const m of callMatches) {
      const nameNode = getCaptureNode(m, CAPTURE_NAMES.CALL_NAME)
      const defNode = getCaptureNode(m, CAPTURE_NAMES.CALL_DEF)
      if (!nameNode || !defNode) continue
      if (calls.length >= LIMITS.MAX_SYMBOLS_PER_FILE) break

      const enclosingFunc = findEnclosingFunction(defNode, language)
      const callerSym = enclosingFunc ? funcNodeToSymbol.get(enclosingFunc.id) : null

      // spec 4.3：用户 ⌘+点击 callee 名字。line/col 用 nameNode 的位置，
      // 这样 resolveSymbolAt 能直接根据点击位置匹配到调用点
      calls.push({
        file,
        line: nameNode.startPosition.row + 1,
        col: nameNode.startPosition.column + 1,
        calleeName: nameNode.text,
        callerFunctionId: callerSym?.id ?? null,
        code: lines[defNode.startPosition.row] ?? '',
        resolvedCalleeId: null,
        status: 'unresolved-notfound',
      })
    }
    result.calls = calls

    return result
  } catch (err: any) {
    result.error = String(err?.message || err)
    return result
  } finally {
    // 释放 wasm 内存（spec 5.6 内存占用受控）
    try {
      tree?.delete()
    } catch {
      /* ignore */
    }
    try {
      parser?.delete()
    } catch {
      /* ignore */
    }
  }
}

// 工具：从文件路径扩展名推断语言（供 renderer 端使用，不在 worker 内强制）
export function detectLanguage(filePath: string): AppLanguage | null {
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return 'typescript'
    case 'tsx':
      // tsx 也走 typescript grammar（package 里有独立 tsx wasm，但 Phase 1 用 TS 即可）
      return 'typescript'
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return 'javascript'
    case 'py':
      return 'python'
    case 'java':
      return 'java'
    case 'kt':
    case 'kts':
      return 'kotlin'
    default:
      return null
  }
}
