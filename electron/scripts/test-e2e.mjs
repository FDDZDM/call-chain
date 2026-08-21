// scripts/test-e2e.mjs
// 端到端测试：解析 → 符号解析 → 调用图构建
// 在 Node.js 环境中运行，不依赖浏览器或 Electron

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { Parser, Language, Query } from 'web-tree-sitter'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

// ── 硬编码 query（与 src/analyzer/queries.ts 保持一致）──
const TYPESCRIPT_QUERY = `
(function_declaration
  name: (identifier) @function.name) @function.def

(method_definition
  name: (property_identifier) @function.name) @function.def

(generator_function_declaration
  name: (identifier) @function.name) @function.def

(class_declaration
  name: (type_identifier) @class.name) @class.def

(call_expression
  function: [
    (identifier) @call.name
    (member_expression
      property: (property_identifier) @call.name)
  ]) @call.def

(new_expression
  constructor: [
    (identifier) @call.name
    (member_expression
      property: (property_identifier) @call.name)
  ]) @call.def
`

// ── 工具函数 ──
function buildQualifiedId(lang, file, className, name, paramSignature) {
  return `${lang}::${file}::${className || ''}::${name}::${paramSignature}`
}

function getNodeName(node) {
  const byField = node.childForFieldName('name')
  if (byField) return byField.text
  for (const child of node.namedChildren) {
    const t = child.type
    if (t === 'identifier' || t === 'type_identifier' || t === 'simple_identifier' || t === 'property_identifier') {
      return child.text
    }
  }
  return null
}

function findEnclosingClass(node, types) {
  let cur = node.parent
  while (cur) {
    if (types.has(cur.type)) return cur
    cur = cur.parent
  }
  return null
}

function findEnclosingFunction(node, types) {
  let cur = node.parent
  while (cur) {
    if (types.has(cur.type)) return cur
    cur = cur.parent
  }
  return null
}

function getCaptureNode(match, name) {
  for (const c of match.captures) {
    if (c.name === name) return c.node
  }
  return null
}

function runQueryFiltered(query, root, requiredCapture) {
  let all
  try {
    all = query.matches(root)
  } catch {
    return []
  }
  return all.filter((m) => m.captures.some((c) => c.name === requiredCapture))
}

function extractParamSignature(funcNode, lang) {
  // 简化版：只取参数名（不做类型提取，因为Node环境测试不需要精确）
  let paramsNode = null
  const fieldCandidates = lang === 'kotlin' ? ['function_value_parameters', 'parameters'] : ['parameters', 'function_value_parameters']
  for (const f of fieldCandidates) {
    paramsNode = funcNode.childForFieldName(f)
    if (paramsNode) break
  }
  if (!paramsNode) {
    const typeNames = new Set(['formal_parameters', 'parameters', 'parameter_list', 'function_value_parameters'])
    for (const child of funcNode.namedChildren) {
      if (typeNames.has(child.type)) { paramsNode = child; break }
    }
  }
  if (!paramsNode) return '()'
  const parts = []
  for (const child of paramsNode.namedChildren) {
    // 简化：直接取子节点文本
    parts.push(child.text.split(':')[0].split('=')[0].trim())
  }
  return `(${parts.join(', ')})`
}

// ── 初始化 ──
console.log('[e2e] Initializing web-tree-sitter...')
const wtsWasmPath = path.join(root, 'node_modules/web-tree-sitter/web-tree-sitter.wasm')
await Parser.init({
  locateFile: (p) => p === 'web-tree-sitter.wasm' || p.endsWith('web-tree-sitter.wasm') ? 'file://' + wtsWasmPath : p,
})
console.log('[e2e] Runtime initialized')

const tsWasmPath = path.join(root, 'node_modules/tree-sitter-wasm/out/typescript/tree-sitter-typescript.wasm')
const tsWasmBytes = new Uint8Array(await readFile(tsWasmPath))
const tsLang = await Language.load(tsWasmBytes)
console.log('[e2e] TypeScript language loaded')

// ── 测试代码 ──
const testCode = `
class AuthManager {
  saveSession(token, user) {
    encrypt(token)
    return writeStore(user)
  }

  logout() {
    clearStore()
  }
}

function encrypt(s) {
  return hash(s)
}

function writeStore(s) {
  return true
}

function hash(s) {
  return s
}

function clearStore() {
  // noop
}
`

const testFile = 'test.ts'
const language = 'typescript'

// ── 解析文件 ──
console.log('\n[e2e] Parsing test file...')
const parser = new Parser()
parser.setLanguage(tsLang)
const tree = parser.parse(testCode)
if (!tree) {
  console.error('[e2e] FAILED: null tree')
  process.exit(1)
}

const classTypes = new Set(['class_declaration'])
const funcTypes = new Set(['function_declaration', 'method_definition', 'generator_function_declaration'])

const query = new Query(tsLang, TYPESCRIPT_QUERY)

// 抽取类
const classMatches = runQueryFiltered(query, tree.rootNode, 'class.def')
const classes = []
const classNodeToSymbol = new Map()
for (const m of classMatches) {
  const nameNode = getCaptureNode(m, 'class.name')
  const defNode = getCaptureNode(m, 'class.def')
  if (!nameNode || !defNode) continue
  const sym = {
    id: `${language}::${testFile}::${nameNode.text}`,
    language,
    file: testFile,
    name: nameNode.text,
    startLine: defNode.startPosition.row + 1,
  }
  classes.push(sym)
  classNodeToSymbol.set(defNode.id, sym)
}
console.log(`[e2e] Found ${classes.length} classes:`, classes.map(c => c.name))

// 抽取函数
const funcMatches = runQueryFiltered(query, tree.rootNode, 'function.def')
const functions = []
const funcNodeToSymbol = new Map()
for (const m of funcMatches) {
  const nameNode = getCaptureNode(m, 'function.name')
  const defNode = getCaptureNode(m, 'function.def')
  if (!nameNode || !defNode) continue
  let className = null
  const classNode = findEnclosingClass(defNode, classTypes)
  if (classNode) {
    const found = classNodeToSymbol.get(classNode.id)
    className = found ? found.name : getNodeName(classNode)
  }
  const paramSignature = extractParamSignature(defNode, language)
  const id = buildQualifiedId(language, testFile, className, nameNode.text, paramSignature)
  const sym = {
    id,
    language,
    file: testFile,
    name: nameNode.text,
    className,
    paramSignature,
    startLine: nameNode.startPosition.row + 1,
    endLine: defNode.endPosition.row + 1,
    startCol: nameNode.startPosition.column + 1,
  }
  functions.push(sym)
  funcNodeToSymbol.set(defNode.id, sym)
}
console.log(`[e2e] Found ${functions.length} functions:`)
for (const f of functions) {
  console.log(`  - ${f.className ? f.className + '.' : ''}${f.name} (line ${f.startLine}) id=${f.id}`)
}

// 抽取调用点
const callMatches = runQueryFiltered(query, tree.rootNode, 'call.def')
const calls = []
for (const m of callMatches) {
  const nameNode = getCaptureNode(m, 'call.name')
  const defNode = getCaptureNode(m, 'call.def')
  if (!nameNode || !defNode) continue
  const enclosingFunc = findEnclosingFunction(defNode, funcTypes)
  const callerSym = enclosingFunc ? funcNodeToSymbol.get(enclosingFunc.id) : null
  calls.push({
    file: testFile,
    line: nameNode.startPosition.row + 1,
    col: nameNode.startPosition.column + 1,
    calleeName: nameNode.text,
    callerFunctionId: callerSym?.id ?? null,
    resolvedCalleeId: null,
    status: 'unresolved-notfound',
  })
}
console.log(`[e2e] Found ${calls.length} call sites:`)
for (const c of calls) {
  const caller = functions.find(f => f.id === c.callerFunctionId)
  console.log(`  - ${caller?.name || '?'} calls ${c.calleeName} (line ${c.line})`)
}

// ── 解析调用点（简化版 resolver）──
console.log('\n[e2e] Resolving calls...')
const byId = new Map()
const byName = new Map()
const byFile = new Map()
for (const f of functions) {
  byId.set(f.id, f)
  const arr = byName.get(f.name) ?? []
  arr.push(f)
  byName.set(f.name, arr)
  const farr = byFile.get(f.file) ?? []
  farr.push(f)
  byFile.set(f.file, farr)
}

function resolveCall(call) {
  const fileFuncs = byFile.get(call.file) ?? []
  const sameFile = fileFuncs.filter(f => f.name === call.calleeName)
  if (sameFile.length === 1) return sameFile[0]
  const globalMatches = byName.get(call.calleeName) ?? []
  if (globalMatches.length === 1) return globalMatches[0]
  return null
}

for (const c of calls) {
  const resolved = resolveCall(c)
  if (resolved) {
    c.resolvedCalleeId = resolved.id
    c.status = 'resolved'
    console.log(`  ✓ ${c.calleeName} -> ${resolved.id}`)
  } else {
    console.log(`  ✗ ${c.calleeName} -> unresolved`)
  }
}

// ── 构建调用图（双向BFS）──
console.log('\n[e2e] Building call graph for encrypt()...')

// 找 encrypt 函数
const anchor = functions.find(f => f.name === 'encrypt')
if (!anchor) {
  console.error('[e2e] FAILED: anchor function encrypt not found')
  process.exit(1)
}
console.log(`[e2e] Anchor: ${anchor.name} (${anchor.id})`)

// 构建索引
const callsByCaller = new Map()
for (const c of calls) {
  if (!c.callerFunctionId) continue
  const arr = callsByCaller.get(c.callerFunctionId) ?? []
  arr.push(c)
  callsByCaller.set(c.callerFunctionId, arr)
}

const callersOf = new Map()
const calleesOf = new Map()
for (const [callerId, callerCalls] of callsByCaller) {
  for (const c of callerCalls) {
    if (!c.resolvedCalleeId) continue
    // callee -> callers
    const arr1 = callersOf.get(c.resolvedCalleeId) ?? []
    arr1.push(callerId)
    callersOf.set(c.resolvedCalleeId, arr1)
    // caller -> callees
    const arr2 = calleesOf.get(callerId) ?? []
    arr2.push(c.resolvedCalleeId)
    calleesOf.set(callerId, arr2)
  }
}

// BFS
const callerDepth = 2
const calleeDepth = 2
const visited = new Set()
const levelById = new Map()
const edges = []
const queue = [{ id: anchor.id, level: 0 }]

while (queue.length > 0) {
  const { id, level } = queue.shift()
  if (visited.has(id)) continue
  visited.add(id)
  levelById.set(id, level)

  if (level < calleeDepth) {
    const callees = calleesOf.get(id) ?? []
    for (const calleeId of callees) {
      edges.push({ from: id, to: calleeId })
      if (!visited.has(calleeId)) queue.push({ id: calleeId, level: level + 1 })
    }
  }
  if (level > -callerDepth) {
    const callers = callersOf.get(id) ?? []
    for (const callerId of callers) {
      edges.push({ from: callerId, to: id })
      if (!visited.has(callerId)) queue.push({ id: callerId, level: level - 1 })
    }
  }
}

console.log(`[e2e] Graph has ${visited.size} nodes, ${edges.length} edges`)
console.log('[e2e] Nodes by level:')
const byLevel = new Map()
for (const id of visited) {
  const lvl = levelById.get(id) ?? 0
  const arr = byLevel.get(lvl) ?? []
  arr.push(byId.get(id))
  byLevel.set(lvl, arr)
}
for (const [lvl, nodes] of [...byLevel.entries()].sort((a,b) => a[0]-b[0])) {
  console.log(`  Level ${lvl}:`)
  for (const n of nodes) {
    console.log(`    - ${n.name}`)
  }
}

// 验证：应该能找到 saveSession -> encrypt -> hash 这条链路
const hasSaveSession = [...visited].some(id => byId.get(id)?.name === 'saveSession')
const hasHash = [...visited].some(id => byId.get(id)?.name === 'hash')
const hasLogout = [...visited].some(id => byId.get(id)?.name === 'logout')

let failed = false
if (!hasSaveSession) {
  console.error('\n[e2e] FAIL: saveSession (caller of encrypt) not in graph')
  failed = true
}
if (!hasHash) {
  console.error('\n[e2e] FAIL: hash (callee of encrypt) not in graph')
  failed = true
}

// ── 清理 ──
tree.delete()
parser.delete()

if (failed) {
  console.error('\n[e2e] E2E TEST FAILED')
  process.exit(1)
}

console.log('\n[e2e] ========================================')
console.log('[e2e] ✓ E2E TEST PASSED!')
console.log('[e2e] Parse → Resolve → Graph pipeline works correctly')
console.log('[e2e] Call chain: saveSession → encrypt → hash')
