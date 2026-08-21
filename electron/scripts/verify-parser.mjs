// scripts/verify-parser.mjs
// 验证脚本（不依赖 Vite，直接在 Node 中加载 wasm）：
//   1. 初始化 web-tree-sitter runtime
//   2. 加载 TypeScript grammar wasm
//   3. 解析一段示例 TS 代码
//   4. 执行 tree-sitter query，打印抽取出的函数定义 / 类 / 调用点
//
// 运行：node scripts/verify-parser.mjs

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { Parser, Language, Query } from 'web-tree-sitter'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

// ── 1. 初始化 web-tree-sitter runtime ──
// locateFile 把内部对 web-tree-sitter.wasm 的请求重定向到 node_modules 中的实际文件
const wtsWasmPath = path.join(
  root,
  'node_modules/web-tree-sitter/web-tree-sitter.wasm',
)
const wtsWasmUrl = 'file://' + wtsWasmPath
await Parser.init({
  locateFile: (p) =>
    p === 'web-tree-sitter.wasm' || p.endsWith('web-tree-sitter.wasm')
      ? wtsWasmUrl
      : p,
})
console.log('[verify] web-tree-sitter runtime initialized')

// ── 2. 加载 TypeScript grammar（从磁盘读 Uint8Array） ──
const tsWasmPath = path.join(
  root,
  'node_modules/tree-sitter-wasm/out/typescript/tree-sitter-typescript.wasm',
)
const tsWasmBytes = new Uint8Array(await readFile(tsWasmPath))
const tsLang = await Language.load(tsWasmBytes)
console.log(`[verify] TypeScript language loaded (abi=${tsLang.abiVersion})`)

// ── 3. 解析示例 TS 代码 ──
const parser = new Parser()
parser.setLanguage(tsLang)

const sample = `\
class AuthManager {
  /** 保存会话 */
  saveSession(token: string, user: Session): boolean {
    encrypt(token)
    return writeStore(user)
  }

  logout(): void {
    clearStore()
  }
}

function encrypt(s: string): string {
  return hash(s)
}

function writeStore(s: Session): boolean {
  return true
}

function hash(s: string): string {
  return s
}

function clearStore(): void {
  // noop
}
`

const tree = parser.parse(sample)
if (!tree) {
  console.error('[verify] FAILED: tree-sitter returned null tree')
  process.exit(1)
}
console.log(`[verify] tree parsed, root type: ${tree.rootNode.type}`)

// ── 4. 执行 query 抽取函数 / 类 / 调用 ──
// 与 src/analyzer/queries.ts 的 TYPESCRIPT_QUERY 等价（这里硬编码副本以脱离 Vite 解析）
const querySrc = `
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

const query = new Query(tsLang, querySrc)
const matches = query.matches(tree.rootNode)

// 按 capture 名分组打印
const funcDefs = []
const classDefs = []
const calls = []
for (const m of matches) {
  const byName = {}
  for (const c of m.captures) byName[c.name] = c.node
  if (byName['function.def'] && byName['function.name']) {
    funcDefs.push({
      name: byName['function.name'].text,
      startLine: byName['function.def'].startPosition.row + 1,
    })
  } else if (byName['class.def'] && byName['class.name']) {
    classDefs.push({
      name: byName['class.name'].text,
      startLine: byName['class.def'].startPosition.row + 1,
    })
  } else if (byName['call.def'] && byName['call.name']) {
    calls.push({
      name: byName['call.name'].text,
      line: byName['call.name'].startPosition.row + 1,
    })
  }
}

console.log('\n[verify] === Classes ===')
for (const c of classDefs) console.log(`  ${c.name}  (line ${c.startLine})`)

console.log('\n[verify] === Functions ===')
for (const f of funcDefs) console.log(`  ${f.name}  (line ${f.startLine})`)

console.log('\n[verify] === Calls ===')
for (const c of calls) console.log(`  ${c.name}  (line ${c.line})`)

// ── 5. 断言：核心期望 ──
const expectedFunctions = ['saveSession', 'logout', 'encrypt', 'writeStore', 'hash', 'clearStore']
const expectedCalls = ['encrypt', 'writeStore', 'hash', 'clearStore']
const expectedClasses = ['AuthManager']

const missingFuncs = expectedFunctions.filter((n) => !funcDefs.some((f) => f.name === n))
const missingCalls = expectedCalls.filter((n) => !calls.some((c) => c.name === n))
const missingClasses = expectedClasses.filter((n) => !classDefs.some((c) => c.name === n))

let failed = false
if (missingFuncs.length) {
  console.error(`[verify] FAIL: missing functions: ${missingFuncs.join(', ')}`)
  failed = true
}
if (missingCalls.length) {
  console.error(`[verify] FAIL: missing calls: ${missingCalls.join(', ')}`)
  failed = true
}
if (missingClasses.length) {
  console.error(`[verify] FAIL: missing classes: ${missingClasses.join(', ')}`)
  failed = true
}

// ── 6. 清理 wasm 内存 ──
tree.delete()
parser.delete()

if (failed) {
  console.error('\n[verify] VERIFICATION FAILED')
  process.exit(1)
}
console.log('\n[verify] OK - tree-sitter wasm 解析链路工作正常')
