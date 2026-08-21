// scripts/test-kotlin.mjs
// 测试 Kotlin grammar 和 query

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { Parser, Language, Query } from 'web-tree-sitter'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

console.log('[kotlin-test] Initializing web-tree-sitter...')
const wtsWasmPath = path.join(root, 'node_modules/web-tree-sitter/web-tree-sitter.wasm')
await Parser.init({
  locateFile: (p) => p === 'web-tree-sitter.wasm' || p.endsWith('web-tree-sitter.wasm') ? 'file://' + wtsWasmPath : p,
})
console.log('[kotlin-test] Runtime initialized')

const kotlinWasmPath = path.join(root, 'node_modules/tree-sitter-wasm/out/kotlin/tree-sitter-kotlin.wasm')
const kotlinWasmBytes = new Uint8Array(await readFile(kotlinWasmPath))
const kotlinLang = await Language.load(kotlinWasmBytes)
console.log('[kotlin-test] Kotlin language loaded')

// 简单的 Kotlin 测试代码
const testCode = `
package com.example.auth

class SettingsAuthRepository {
    fun saveSettings(token: String) {
        encrypt(token)
        writeToStore(token)
    }

    fun loadSettings(): String {
        return readFromStore()
    }

    private fun encrypt(input: String): String {
        return hash(input)
    }

    private fun hash(s: String): String {
        return s
    }
}

fun topLevelFunc() {
    println("hello")
}
`

const parser = new Parser()
parser.setLanguage(kotlinLang)
const tree = parser.parse(testCode)
if (!tree) {
  console.error('[kotlin-test] FAILED: null tree')
  process.exit(1)
}

// 先打印语法树看看 node 类型
function printTree(node, indent = 0) {
  const prefix = '  '.repeat(indent)
  const text = node.text.length > 40 ? node.text.slice(0, 40) + '...' : node.text.replace(/\n/g, '\\n')
  console.log(`${prefix}${node.type} [${node.startPosition.row}:${node.startPosition.column}-${node.endPosition.row}:${node.endPosition.column}] "${text}"`)
  for (const child of node.namedChildren) {
    printTree(child, indent + 1)
  }
}

console.log('\n[kotlin-test] Syntax tree:')
printTree(tree.rootNode)

// 尝试各种 query
const queries = [
  // 1. 基础 function_declaration
  `
(function_declaration
  (simple_identifier) @function.name) @function.def
`,
  // 2. 带 class_declaration
  `
(class_declaration
  (type_identifier) @class.name) @class.def

(function_declaration
  (simple_identifier) @function.name) @function.def
`,
  // 3. call_expression
  `
(call_expression
  (simple_identifier) @call.name) @call.def
`,
  // 4. 尝试navigation_expression
  `
(navigation_expression
  (navigation_suffix
    (simple_identifier) @call.name)) @call.def
`,
]

for (let i = 0; i < queries.length; i++) {
  console.log(`\n[kotlin-test] Testing query ${i + 1}:`)
  console.log(queries[i])
  try {
    const q = new Query(kotlinLang, queries[i])
    const matches = q.matches(tree.rootNode)
    console.log(`  ✓ Query compiled, ${matches.length} matches`)
    for (const m of matches.slice(0, 10)) {
      for (const c of m.captures) {
        console.log(`    - ${c.name}: "${c.node.text}" at ${c.node.startPosition.row}:${c.node.startPosition.column}`)
      }
    }
  } catch (err) {
    console.log(`  ✗ Query failed: ${err.message}`)
  }
}

// 测试 FUNCTION_DEF_NODE_TYPES 中应包含哪些
console.log('\n[kotlin-test] Checking for function-like node types in tree:')
const funcTypes = new Set()
function collectFuncTypes(node) {
  if (node.type.includes('function') || node.type.includes('declaration') && node.type !== 'class_declaration') {
    funcTypes.add(node.type)
  }
  for (const child of node.namedChildren) collectFuncTypes(child)
}
collectFuncTypes(tree.rootNode)
console.log('  Function-like types:', Array.from(funcTypes))

tree.delete()
parser.delete()
