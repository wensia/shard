import { validatePropertyDate, validatePropertyDateTime, type PropertyType } from "@/lib/properties"
import type { Fragment, PropertyRegistry, PropertyValue } from "@/types"

export type PropertyFilterOperator =
  | "exists"
  | "missing"
  | "empty"
  | "notEmpty"
  | "equals"
  | "contains"
  | "eq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "on"
  | "before"
  | "after"
  | "isTrue"
  | "isFalse"
  | "includes"

export interface PropertyFilter {
  key: string
  op: PropertyFilterOperator
  value?: string | [string, string]
}

export type PropertyTypeEntries = PropertyRegistry["properties"]

const COMMON_OPERATORS = new Set<PropertyFilterOperator>(["exists", "missing", "empty", "notEmpty"])
const TYPE_OPERATORS: Record<PropertyType, readonly PropertyFilterOperator[]> = {
  text: ["equals", "contains"],
  link: ["equals", "contains"],
  number: ["eq", "gt", "gte", "lt", "lte", "between"],
  date: ["on", "before", "after", "between"],
  datetime: ["before", "after", "between"],
  checkbox: ["isTrue", "isFalse"],
  list: ["includes"],
}

const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u

interface DecimalParts {
  sign: -1 | 0 | 1
  integer: string
  fraction: string
}

function parseDecimal(text: string): DecimalParts | null {
  const normalized = text.trim()
  if (!DECIMAL_PATTERN.test(normalized)) return null
  const negative = normalized.startsWith("-")
  const unsigned = normalized.replace(/^[+-]/u, "")
  const [rawInteger = "", rawFraction = ""] = unsigned.split(".")
  const integer = rawInteger.replace(/^0+(?=\d)/u, "") || "0"
  const fraction = rawFraction.replace(/0+$/u, "")
  const sign = integer === "0" && fraction === "" ? 0 : negative ? -1 : 1
  return { sign, integer, fraction }
}

function compareMagnitude(left: DecimalParts, right: DecimalParts) {
  if (left.integer.length !== right.integer.length) {
    return left.integer.length < right.integer.length ? -1 : 1
  }
  if (left.integer !== right.integer) return left.integer < right.integer ? -1 : 1
  const length = Math.max(left.fraction.length, right.fraction.length)
  for (let index = 0; index < length; index += 1) {
    const leftDigit = left.fraction[index] ?? "0"
    const rightDigit = right.fraction[index] ?? "0"
    if (leftDigit !== rightDigit) return leftDigit < rightDigit ? -1 : 1
  }
  return 0
}

export function compareDecimalText(left: string, right: string): number | null {
  const leftParts = parseDecimal(left)
  const rightParts = parseDecimal(right)
  if (!leftParts || !rightParts) return null
  if (leftParts.sign !== rightParts.sign) return leftParts.sign < rightParts.sign ? -1 : 1
  if (leftParts.sign === 0) return 0
  const magnitude = compareMagnitude(leftParts, rightParts)
  return leftParts.sign === -1 ? -magnitude : magnitude
}

export function propertyFilterType(key: string, entries?: PropertyTypeEntries | null): PropertyType {
  return entries?.[key]?.type ?? "text"
}

export function propertyFilterOperators(type: PropertyType): readonly PropertyFilterOperator[] {
  return ["exists", "missing", "empty", "notEmpty", ...TYPE_OPERATORS[type]]
}

function isOperatorForType(operator: PropertyFilterOperator, type: PropertyType) {
  return COMMON_OPERATORS.has(operator) || TYPE_OPERATORS[type].includes(operator)
}

function pair(value: PropertyFilter["value"]): [string, string] | null {
  return Array.isArray(value) && value.length === 2 ? value : null
}

function scalar(value: PropertyFilter["value"]): string | null {
  return typeof value === "string" ? value : null
}

function validDateTimeOperand(value: string) {
  return validatePropertyDateTime(value) === null
}

export function comparablePropertyDateTime(value: string): string | null {
  const prefix = value.slice(0, 16)
  if (validatePropertyDateTime(prefix)) return null
  const suffix = value.slice(16)
  if (!suffix || /^(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(suffix)) {
    return prefix
  }
  return null
}

function compareByType(left: string, right: string, type: "number" | "date" | "datetime") {
  if (type === "number") return compareDecimalText(left, right)
  const normalizedLeft = type === "datetime" ? comparablePropertyDateTime(left) : validatePropertyDate(left) ? null : left
  const normalizedRight = type === "datetime" ? comparablePropertyDateTime(right) : validatePropertyDate(right) ? null : right
  if (!normalizedLeft || !normalizedRight) return null
  return normalizedLeft === normalizedRight ? 0 : normalizedLeft < normalizedRight ? -1 : 1
}

export function validatePropertyFilter(filter: PropertyFilter, type: PropertyType): string | null {
  if (!filter.key) return "请选择属性名。"
  if (!isOperatorForType(filter.op, type)) return "当前属性类型不支持该运算。"
  if (COMMON_OPERATORS.has(filter.op) || filter.op === "isTrue" || filter.op === "isFalse") return null

  if (filter.op === "between") {
    const values = pair(filter.value)
    if (!values || values.some(value => value.trim() === "")) return "请填写完整的范围。"
    const comparisonType = type === "number" || type === "date" || type === "datetime" ? type : null
    if (!comparisonType) return "当前属性类型不支持范围运算。"
    const comparison = compareByType(values[0], values[1], comparisonType)
    if (comparison === null) {
      return type === "number" ? "数字格式无效。" : type === "date" ? "日期格式无效。" : "日期时间格式无效。"
    }
    if (comparison > 0) return "范围下限不能晚于或大于上限。"
    return null
  }

  const value = scalar(filter.value)
  if (value === null || value.trim() === "") return "请填写属性值。"
  if (type === "number" && compareDecimalText(value, value) === null) return "数字格式无效。"
  if (type === "date" && validatePropertyDate(value)) return "日期格式无效。"
  if (type === "datetime" && !validDateTimeOperand(value)) return "日期时间格式无效。"
  return null
}

function isEmpty(value: PropertyValue) {
  return value.kind === "null"
    || (value.kind === "text" && value.text === "")
    || (value.kind === "list" && value.items.length === 0)
}

function orderedMatch(comparison: number, operator: PropertyFilterOperator) {
  if (operator === "eq" || operator === "on") return comparison === 0
  if (operator === "gt" || operator === "after") return comparison > 0
  if (operator === "gte") return comparison >= 0
  if (operator === "lt" || operator === "before") return comparison < 0
  if (operator === "lte") return comparison <= 0
  return false
}

export function matchesPropertyFilter(
  fragment: Fragment,
  filter: PropertyFilter,
  entries?: PropertyTypeEntries | null
) {
  const property = (fragment.properties ?? []).find(candidate => candidate.key === filter.key)
  if (filter.op === "missing") return !property
  if (!property) return false
  if (filter.op === "exists") return true
  if (filter.op === "empty") return isEmpty(property.value)
  if (filter.op === "notEmpty") return !isEmpty(property.value)

  const type = propertyFilterType(filter.key, entries)
  if (validatePropertyFilter(filter, type)) return false
  const value = scalar(filter.value)

  if ((type === "text" || type === "link") && property.value.kind === "text" && value !== null) {
    if (filter.op === "equals") return property.value.text === value
    if (filter.op === "contains") return property.value.text.toLowerCase().includes(value.toLowerCase())
  }
  if (type === "number" && property.value.kind === "number") {
    if (filter.op === "between") {
      const values = pair(filter.value)!
      const lower = compareDecimalText(property.value.text, values[0])
      const upper = compareDecimalText(property.value.text, values[1])
      return lower !== null && upper !== null && lower >= 0 && upper <= 0
    }
    if (value !== null) {
      const comparison = compareDecimalText(property.value.text, value)
      return comparison !== null && orderedMatch(comparison, filter.op)
    }
  }
  if (type === "date" && property.value.kind === "text") {
    if (filter.op === "between") {
      const values = pair(filter.value)!
      return validatePropertyDate(property.value.text) === null
        && property.value.text >= values[0] && property.value.text <= values[1]
    }
    if (value !== null && validatePropertyDate(property.value.text) === null) {
      const comparison = property.value.text === value ? 0 : property.value.text < value ? -1 : 1
      return orderedMatch(comparison, filter.op)
    }
  }
  if (type === "datetime" && property.value.kind === "text") {
    const comparable = comparablePropertyDateTime(property.value.text)
    if (!comparable) return false
    if (filter.op === "between") {
      const values = pair(filter.value)!
      return comparable >= values[0] && comparable <= values[1]
    }
    if (value !== null) {
      const comparison = comparable === value ? 0 : comparable < value ? -1 : 1
      return orderedMatch(comparison, filter.op)
    }
  }
  if (type === "checkbox" && property.value.kind === "bool") {
    return filter.op === "isTrue" ? property.value.value : filter.op === "isFalse" && !property.value.value
  }
  if (type === "list" && property.value.kind === "list" && value !== null && filter.op === "includes") {
    return property.value.items.includes(value)
  }
  return false
}
