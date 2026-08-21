// src/analyzer/queries.ts
// spec 3.6：每种语言一份 tree-sitter query（.scm 格式字符串）
//
// 统一抽取三类符号：FunctionDefinition / FunctionCall / ClassDefinition
//   - @function.def：整个函数定义节点
//   - @function.name：函数名标识符
//   - @call.def：整个调用表达式节点
//   - @call.name：被调用函数名标识符
//   - @class.def：整个类定义节点
//   - @class.name：类名标识符
//
// 设计原则：
//   1. 只匹配有函数体的定义（接口/签名声明不参与调用图）
//   2. 调用表达式只匹配具名调用（identifier / member_expression 的 property），
//      忽略链式 / 下标 / 立即调用等复杂形式（Phase 1 精度足够）
//   3. 不写父节点结构（class 包裹等由 parser 通过 parent 链自行推断）
//   4. query 失败时由 parser 容错（构造 Query 抛错时记录 error 继续）

import type { Language } from '@/types/models'

// TypeScript query
// 覆盖：function 声明、方法定义、generator、class、调用表达式、new 表达式
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

// JavaScript query（与 TS 同源语法，但 class 名用 identifier 而非 type_identifier）
const JAVASCRIPT_QUERY = `
(function_declaration
  name: (identifier) @function.name) @function.def

(method_definition
  name: (property_identifier) @function.name) @function.def

(generator_function_declaration
  name: (identifier) @function.name) @function.def

(class_declaration
  name: (identifier) @class.name) @class.def

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

// Python query
// call 节点的 function 子节点可能是 identifier（foo()）或 attribute（obj.foo()）
const PYTHON_QUERY = `
(function_definition
  name: (identifier) @function.name) @function.def

(class_definition
  name: (identifier) @class.name) @class.def

(call
  function: [
    (identifier) @call.name
    (attribute
      attribute: (identifier) @call.name)
  ]) @call.def
`

// Java query
// 方法调用：method_invocation（obj.foo() / foo()）
// 构造调用：object_creation_expression（new Foo()）
// 方法定义：method_declaration / constructor_declaration
const JAVA_QUERY = `
(method_declaration
  name: (identifier) @function.name) @function.def

(constructor_declaration
  name: (identifier) @function.name) @function.def

(class_declaration
  name: (identifier) @class.name) @class.def

(method_invocation
  name: (identifier) @call.name) @call.def

(object_creation_expression
  type: (type_identifier) @call.name) @call.def
`

// Kotlin query
// Kotlin grammar:
//   - function_declaration 的第一个 simple_identifier 是函数名（modifiers 在前面）
//   - 直接调用 foo(): (call_expression (simple_identifier) (call_suffix))
//   - 成员调用 obj.foo()/obj?.foo(): (call_expression (navigation_expression (navigation_suffix (simple_identifier))) (call_suffix))
// 注意：query 中 (simple_identifier) 会递归匹配所有子 simple_identifier，
// 但 Kotlin grammar 中 call_expression 的 namedChildren 要么是 simple_identifier（直接调用）
// 要么是 navigation_expression（成员调用），参数在 call_suffix 内，call_suffix 内的
// simple_identifier 不是 call_expression 的直接子节点而是 call_suffix 的子节点。
// 经测试验证，Kotlin 中此 query 无误匹配。
const KOTLIN_QUERY = `
(function_declaration
  (simple_identifier) @function.name) @function.def

(class_declaration
  (type_identifier) @class.name) @class.def

; 直接调用 foo()
(call_expression
  (simple_identifier) @call.name) @call.def

; 成员/安全调用 obj.foo() / obj?.foo()
(call_expression
  (navigation_expression
    (navigation_suffix
      (simple_identifier) @call.name))) @call.def
`

export const QUERIES: Record<Language, string> = {
  typescript: TYPESCRIPT_QUERY,
  javascript: JAVASCRIPT_QUERY,
  python: PYTHON_QUERY,
  java: JAVA_QUERY,
  kotlin: KOTLIN_QUERY,
}

// 每种语言「函数定义节点类型」集合（用于向上找外层函数 / 类）
export const FUNCTION_DEF_NODE_TYPES: Record<Language, Set<string>> = {
  typescript: new Set([
    'function_declaration',
    'method_definition',
    'generator_function_declaration',
  ]),
  javascript: new Set([
    'function_declaration',
    'method_definition',
    'generator_function_declaration',
  ]),
  python: new Set(['function_definition']),
  java: new Set(['method_declaration', 'constructor_declaration']),
  kotlin: new Set(['function_declaration']),
}

// 每种语言「类定义节点类型」集合
export const CLASS_DEF_NODE_TYPES: Record<Language, Set<string>> = {
  typescript: new Set(['class_declaration']),
  javascript: new Set(['class_declaration']),
  python: new Set(['class_definition']),
  java: new Set(['class_declaration']),
  kotlin: new Set(['class_declaration']),
}

// 捕获名常量（与 parser 内部对齐）
export const CAPTURE_NAMES = {
  FUNCTION_DEF: 'function.def',
  FUNCTION_NAME: 'function.name',
  CALL_DEF: 'call.def',
  CALL_NAME: 'call.name',
  CLASS_DEF: 'class.def',
  CLASS_NAME: 'class.name',
} as const
