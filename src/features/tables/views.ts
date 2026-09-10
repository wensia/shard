import { canonicalJson, compareCodePoints, tableAssert, validateTableContent, type CellValue, type FilterCondition,
  type TableContent, type TableField, type TableRecord, type ViewId } from "./model"
import { ownedTableTimestamp } from "./mutations"

export type TableGridRow = { kind: "record"; recordId: string } | { kind: "group"; key: string }
export type TableProjection = {
  generation: number; displayRevision: number; viewId: ViewId; recordIds: string[]; gridRows: TableGridRow[]
  groups: { key: string; value: CellValue; start: number; count: number; collapsed: boolean; gridStart: number }[]
}
type DisplayOptions = { collapsedGroups?: ReadonlySet<string>; displayRevision?: number }
type ValueComparator = (left: CellValue | undefined, right: CellValue | undefined, descending?: boolean) => number

function comparator(field: TableField): ValueComparator {
  const options = "options" in field ? new Map(field.options.map((option, index) => [option.id, index])) : new Map<string, number>()
  return (left, right, descending = false) => {
    // Unset cells remain last even when a sort direction is reversed.
    if (left == null || right == null) return left == null ? (right == null ? 0 : 1) : -1
    let order: number
    switch (field.type) {
      case "text": case "date": order = compareCodePoints(left as string, right as string); break
      case "number": order = (left as number) - (right as number); break
      case "checkbox": order = Number(left) - Number(right); break
      case "select": order = options.get(left as string)! - options.get(right as string)!; break
      case "multiSelect": {
        const a = (left as string[]).map(id => options.get(id)!).sort((x, y) => x - y)
        const b = (right as string[]).map(id => options.get(id)!).sort((x, y) => x - y)
        order = a.length - b.length
        for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) { order = a[i] - b[i]; break }
        break
      }
    }
    return descending ? -order : order
  }
}
function conditionPredicate(condition: FilterCondition): (record: TableRecord) => boolean {
  return record => {
    const value = record.values[condition.fieldId]
    if (condition.operator === "isEmpty" || condition.operator === "isNotEmpty") {
      const empty = value == null || value === "" || (Array.isArray(value) && value.length === 0)
      return condition.operator === "isEmpty" ? empty : !empty
    }
    if (value == null) return false
    switch (condition.operator) {
      case "eq": return value === condition.value
      case "ne": return value !== condition.value
      case "contains": return (value as string).includes(condition.value)
      case "notContains": return !(value as string).includes(condition.value)
      case "startsWith": return (value as string).startsWith(condition.value)
      case "endsWith": return (value as string).endsWith(condition.value)
      case "gt": return (value as string | number) > condition.value
      case "gte": return (value as string | number) >= condition.value
      case "lt": return (value as string | number) < condition.value
      case "lte": return (value as string | number) <= condition.value
      case "between": return (value as string | number) >= condition.lower && (value as string | number) <= condition.upper
      case "in": return condition.optionIds.includes(value as string)
      case "notIn": return !condition.optionIds.includes(value as string)
      case "hasAny": return condition.optionIds.some(id => (value as string[]).includes(id))
      case "hasAll": return condition.optionIds.every(id => (value as string[]).includes(id))
      case "hasNone": return condition.optionIds.every(id => !(value as string[]).includes(id))
    }
  }
}

// Full validation/filtering/sorting is intentionally synchronous pure work for a dedicated Worker.
export function projectTableView(content: TableContent, viewId: ViewId, generation: number, display: DisplayOptions = {}): TableProjection {
  validateTableContent(content)
  return projectValidatedTableView(content, viewId, generation, display)
}
export function projectOwnedTableView(content: TableContent, viewId: ViewId, generation: number, display: DisplayOptions = {}): TableProjection {
  ownedTableTimestamp(content)
  return projectValidatedTableView(content, viewId, generation, display)
}
function projectValidatedTableView(content: TableContent, viewId: ViewId, generation: number, display: DisplayOptions): TableProjection {
  tableAssert(Number.isSafeInteger(generation) && generation >= 0, "/generation")
  const view = content.views[viewId]; tableAssert(view, "/viewId", "视图不存在")
  const conditions = view.filters.conditions.map(conditionPredicate)
  const ordered = content.recordOrder.filter(id => conditions.length === 0 || (view.filters.operator === "and"
    ? conditions.every(match => match(content.records[id])) : conditions.some(match => match(content.records[id]))))
  const sourceOrder = new Map(content.recordOrder.map((id, index) => [id, index]))
  const sorts = view.sorts.map(sort => ({ ...sort, compare: comparator(content.fields[sort.fieldId]) }))
  const groupField = view.groupBy === null ? undefined : content.fields[view.groupBy]
  const compareGroup = groupField ? comparator(groupField) : undefined
  ordered.sort((leftId, rightId) => {
    const left = content.records[leftId]; const right = content.records[rightId]
    if (groupField && compareGroup) { const groupOrder = compareGroup(left.values[groupField.id], right.values[groupField.id]); if (groupOrder) return groupOrder }
    for (const sort of sorts) { const order = sort.compare(left.values[sort.fieldId], right.values[sort.fieldId], sort.direction === "desc"); if (order) return order }
    return sourceOrder.get(leftId)! - sourceOrder.get(rightId)!
  })
  const groups: TableProjection["groups"] = []
  if (groupField) ordered.forEach((id, index) => {
    const value = content.records[id].values[groupField.id] ?? null
    const key = canonicalJson([groupField.type, value])
    const previous = groups[groups.length - 1]
    if (previous?.key === key) previous.count++
    else groups.push({ key, value, start: index, count: 1, collapsed: display.collapsedGroups?.has(key) ?? false, gridStart: 0 })
  })
  const gridRows: TableGridRow[] = []
  if (groupField) for (const group of groups) {
    group.gridStart = gridRows.length
    gridRows.push({ kind: "group", key: group.key })
    if (!group.collapsed) for (let index = group.start; index < group.start + group.count; index++) gridRows.push({ kind: "record", recordId: ordered[index] })
  }
  else for (const recordId of ordered) gridRows.push({ kind: "record", recordId })
  return { generation, displayRevision: display.displayRevision ?? 0, viewId, recordIds: ordered, gridRows, groups }
}
