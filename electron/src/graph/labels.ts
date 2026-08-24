const FIRST_LINE_CHARS = 19
const SECOND_LINE_CHARS = 28
const FILE_CHARS = 32

function visualUnits(value: string): number {
  return [...value].reduce((sum, char) => sum + (/[^\x00-\xff]/.test(char) ? 2 : 1), 0)
}

function sliceToUnits(value: string, maxUnits: number, fromEnd = false): string {
  const chars = [...value]
  const selected: string[] = []
  let used = 0
  const ordered = fromEnd ? chars.reverse() : chars
  for (const char of ordered) {
    const units = /[^\x00-\xff]/.test(char) ? 2 : 1
    if (used + units > maxUnits) break
    selected.push(char)
    used += units
  }
  return (fromEnd ? selected.reverse() : selected).join('')
}

function ellipsize(value: string, maxUnits: number): string {
  if (visualUnits(value) <= maxUnits) return value
  return `${sliceToUnits(value, Math.max(1, maxUnits - 1))}…`
}

function ellipsizeMiddle(value: string, maxUnits: number): string {
  if (visualUnits(value) <= maxUnits) return value
  const tailUnits = Math.max(8, Math.floor(maxUnits * 0.42))
  const headUnits = maxUnits - tailUnits - 1
  return `${sliceToUnits(value, headUnits)}…${sliceToUnits(value, tailUnits, true)}`
}

function findBreak(value: string, maxChars: number): number {
  if (visualUnits(value) <= maxChars) return value.length
  const head = sliceToUnits(value, maxChars + 1)
  const separator = Math.max(head.lastIndexOf('.'), head.lastIndexOf('_'), head.lastIndexOf('-'))
  if (separator >= Math.floor(maxChars * 0.45)) return separator + 1

  for (let index = Math.min(maxChars, value.length - 1); index > Math.floor(maxChars * 0.45); index--) {
    if (/[a-z0-9]/.test(value[index - 1]) && /[A-Z]/.test(value[index])) return index
  }
  return maxChars
}

/** 在点号、下划线或驼峰边界换行，两行之外显式截断。 */
export function wrapQualifiedName(value: string): [string, string?] {
  if (visualUnits(value) <= FIRST_LINE_CHARS) return [value]
  const breakAt = findBreak(value, FIRST_LINE_CHARS)
  const first = value.slice(0, breakAt)
  const rest = value.slice(breakAt)
  return [first, ellipsize(rest, SECOND_LINE_CHARS)]
}

/** 节点只显示最有辨识度的父目录/文件，完整路径留给 tooltip。 */
export function compactSourceLocation(file: string, line: number): string {
  const normalized = file.replaceAll('\\', '/')
  const parts = normalized.split('/').filter(Boolean)
  const compact = parts.length <= 2 ? parts.join('/') : parts.slice(-2).join('/')
  return ellipsizeMiddle(`${compact}:${line}`, FILE_CHARS)
}
