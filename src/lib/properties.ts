export const PROPERTY_TYPES = [
  "text",
  "number",
  "date",
  "datetime",
  "checkbox",
  "list",
  "link",
] as const

export type PropertyType = (typeof PROPERTY_TYPES)[number]

export type PropertyRequestValue =
  | { type: "text"; value: string | null }
  | { type: "number"; value: string | null }
  | { type: "date"; value: string | null }
  | { type: "datetime"; value: string | null }
  | { type: "checkbox"; value: boolean | null }
  | { type: "list"; value: string[] | null }
  | { type: "link"; value: string | null }

export const SYSTEM_PROPERTY_KEYS = new Set([
  "id",
  "created_at",
  "updated_at",
  "tags",
  "category",
  "ai_status",
  "pinned",
  "source",
  "conflict_of",
  "related",
])

const I64_MIN = -9_223_372_036_854_775_808n
const I64_MAX = 9_223_372_036_854_775_807n
const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u
const DATETIME_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/u

export function validatePropertyKey(key: string): string | null {
  if (key.length === 0) return "属性名不能为空。"
  if ([...key].length > 64) return "属性名不能超过 64 个字符。"
  if (key.startsWith("-")) return "属性名不能以 - 开头。"
  if (!/^[\p{L}\p{N}_-]+$/u.test(key)) {
    return "属性名只能包含字母、数字、下划线和连字符。"
  }
  if (SYSTEM_PROPERTY_KEYS.has(key)) return "该属性名是系统保留名。"
  return null
}

export function parsePropertyList(text: string): string[] {
  return text
    .split(/[,，]/u)
    .map((item) => item.trim())
    .filter(Boolean)
}

export function validatePropertyNumber(text: string): string | null {
  const normalized = text.trim()
  if (!DECIMAL_PATTERN.test(normalized)) {
    return "数字格式无效，可改用文本类型。"
  }

  if (!normalized.includes(".")) {
    const integer = BigInt(normalized)
    if (integer < I64_MIN || integer > I64_MAX) {
      return "数字格式无效，可改用文本类型。"
    }
    return null
  }

  if (!Number.isFinite(Number(normalized))) {
    return "数字格式无效，可改用文本类型。"
  }
  return null
}

export function validatePropertyDate(text: string): string | null {
  const match = DATE_PATTERN.exec(text)
  if (!match) return "日期格式应为 YYYY-MM-DD。"

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return "日期无效。"
  }
  return null
}

export function validatePropertyDateTime(text: string): string | null {
  const match = DATETIME_PATTERN.exec(text)
  if (!match) return "日期时间格式应为 YYYY-MM-DDTHH:mm。"
  if (validatePropertyDate(match[1])) return "日期时间无效。"

  const hour = Number(match[2])
  const minute = Number(match[3])
  if (hour > 23 || minute > 59) return "日期时间无效。"
  return null
}

export function buildPropertyRequestValue(
  type: PropertyType,
  input: string | boolean | null | undefined
): PropertyRequestValue {
  if (input == null || input === "") {
    return { type, value: null } as PropertyRequestValue
  }

  if (type === "checkbox") {
    if (typeof input !== "boolean") throw new Error("勾选属性必须是布尔值。")
    return { type, value: input }
  }
  if (typeof input !== "string") throw new Error("属性值格式无效。")

  if (type === "text") return { type, value: input }

  const normalized = input.trim()
  if (normalized === "") return { type, value: null } as PropertyRequestValue

  if (type === "number") {
    const problem = validatePropertyNumber(normalized)
    if (problem) throw new Error(problem)
    return { type, value: normalized }
  }
  if (type === "date") {
    const problem = validatePropertyDate(normalized)
    if (problem) throw new Error(problem)
    return { type, value: normalized }
  }
  if (type === "datetime") {
    const problem = validatePropertyDateTime(normalized)
    if (problem) throw new Error(problem)
    return { type, value: normalized }
  }
  if (type === "list") {
    const items = parsePropertyList(normalized)
    return { type, value: items.length > 0 ? items : null }
  }

  const target =
    normalized.startsWith("[[") && normalized.endsWith("]]")
      ? normalized.slice(2, -2).trim()
      : normalized
  if (!target || target.includes("[[") || target.includes("]]")) {
    throw new Error("链接目标无效。")
  }
  return { type, value: `[[${target}]]` }
}
