import { shardMarkdownParser } from "./syntax.js"
import { getTagRanges } from "./text.js"

/**
 * 备忘提醒的行内写法：`⏰ YYYY-MM-DD HH:mm`（本地时间）。
 *
 * 与 obsidian-reminder 插件的 Tasks 兼容格式一致。分隔只认单个半角空格：
 * 写回时固定输出单空格，放宽成 `\s` 会让制表符、换行在往返后被改写。
 */
export const REMINDER_PATTERN = /⏰ (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/u

const REMINDER_GLOBAL_PATTERN = new RegExp(REMINDER_PATTERN.source, "gu")
const REMINDER_AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/u
const WIKILINK_PATTERN = /!?\[\[[^\]\n]*\]\]/gu

export interface ReminderRange {
  /** 源文本中 `⏰` 的起点。 */
  start: number
  /** 源文本中 `HH:mm` 之后的位置。 */
  end: number
  /** `YYYY-MM-DD HH:mm`。 */
  at: string
}

export interface TaskReminder {
  /** `YYYY-MM-DD HH:mm`。 */
  at: string
  /** 本地时区下的毫秒时间戳。 */
  dueAt: number
  /** 所在任务项是否已勾选。 */
  checked: boolean
}

export interface TaskItem extends TaskReminder {
  /** 零基行号，与 toggleTaskLine 使用同一口径。 */
  lineIndex: number
  text: string
}

const pad = (value: number, length = 2) => String(value).padStart(length, "0")

/** 把本地时间格式化成 `YYYY-MM-DD HH:mm`（不带 `⏰` 前缀）。 */
export function formatReminder(at: Date): string {
  return `${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/**
 * 解析 `YYYY-MM-DD HH:mm` 为本地时区的毫秒时间戳；格式不符或日期不存在返回 null。
 * 夏令时跳过的时刻按 `Date` 的本地规则顺延，不视为非法。
 */
export function parseReminderAt(text: string): number | null {
  const match = REMINDER_AT_PATTERN.exec(text)
  if (!match) return null
  const [year, month, day, hour, minute] = match.slice(1).map(Number)
  if (year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) return null

  const calendar = new Date(0)
  calendar.setUTCFullYear(year, month - 1, day)
  if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null

  const local = new Date(0)
  local.setFullYear(year, month - 1, day)
  local.setHours(hour, minute, 0, 0)
  const time = local.getTime()
  return Number.isFinite(time) ? time : null
}

/** 找出文本里所有合法的提醒写法；非法日期（如 `2026-02-30`）不算提醒。 */
export function findReminderRanges(text: string): ReminderRange[] {
  const ranges: ReminderRange[] = []
  if (!text.includes("⏰")) return ranges
  for (const match of text.matchAll(REMINDER_GLOBAL_PATTERN)) {
    const at = `${match[1]} ${match[2]}`
    if (parseReminderAt(at) === null) continue
    const start = match.index ?? 0
    ranges.push({ start, end: start + match[0].length, at })
  }
  return ranges
}

type MarkdownNode = ReturnType<typeof shardMarkdownParser.parse>["topNode"]

/** 行内不识别提醒的语法区域，与编辑器转换层 `scanAtoms` 的保护口径一致。 */
const PROTECTED_INLINE = new Set([
  "Autolink",
  "CodeText",
  "Entity",
  "Escape",
  "HTMLTag",
  "InlineCode",
  "LinkLabel",
  "LinkTitle",
  "URL",
])

const NESTED_BLOCKS = new Set(["ListItem", "BulletList", "OrderedList"])

function collectExcluded(node: MarkdownNode, out: [number, number][]) {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (PROTECTED_INLINE.has(child.name) || NESTED_BLOCKS.has(child.name)) out.push([child.from, child.to])
    else collectExcluded(child, out)
  }
}

function overlaps(start: number, end: number, ranges: readonly [number, number][]) {
  return ranges.some(([from, to]) => start < to && from < end)
}

/**
 * 汇总文档里每个 GFM 任务项的提醒（每项只取第一个合法提醒）。
 *
 * 只看任务项自身那一段（Lezer 的 `Task` 节点，即标题段及其懒续行），
 * 嵌套子任务的范围被排除，子任务自己的提醒由它自己的 `Task` 计入，不重复计数。
 * 代码、链接目标、标签与双链里出现的 `⏰` 不算提醒，与编辑器的识别口径一致。
 */
export function collectTaskItems(markdown: string): TaskItem[] {
  const items: TaskItem[] = []
  if (!markdown.includes("⏰")) return items

  const tree = shardMarkdownParser.parse(markdown)
  tree.iterate({
    enter(ref) {
      if (ref.name !== "Task") return
      const task = ref.node
      if (task.parent?.name !== "ListItem") return false

      const marker = task.getChild("TaskMarker")
      const checked = marker
        ? markdown.slice(marker.from + 1, marker.from + 2).toLowerCase() === "x"
        : false

      const excluded: [number, number][] = []
      collectExcluded(task, excluded)
      const text = markdown.slice(task.from, task.to)
      for (const tag of getTagRanges(text)) excluded.push([task.from + tag.start, task.from + tag.end])
      for (const link of text.matchAll(WIKILINK_PATTERN)) {
        const start = task.from + (link.index ?? 0)
        excluded.push([start, start + link[0].length])
      }

      for (const range of findReminderRanges(text)) {
        const start = task.from + range.start
        const end = task.from + range.end
        if (overlaps(start, end, excluded)) continue
        const dueAt = parseReminderAt(range.at)
        if (dueAt === null) continue
        const lineIndex = markdown.slice(0, task.from).split("\n").length - 1
        const firstLine = text.split("\n", 1)[0]
        const body = firstLine.replace(/^\s*(?:(?:[-*+]|\d+[.)])\s+)?\[[ xX]\]\s*/u, "")
        items.push({ at: range.at, dueAt, checked, lineIndex, text: (splitTaskReminder(body)?.body ?? body).trim() })
        break
      }
      return false
    },
  })
  return items
}

export function collectTaskReminders(markdown: string): TaskReminder[] {
  return collectTaskItems(markdown).map(({ at, dueAt, checked }) => ({ at, dueAt, checked }))
}

/**
 * 从任务正文里拆出提醒：只读渲染把它画成行尾的时间标记，正文不再露出 `⏰` 原文。
 *
 * 取第一个合法、不在行内代码里的写法（与 `collectTaskReminders`「每个任务只取第一个」一致），
 * 连同它和正文之间的一个分隔空格一起去掉。没有提醒返回 null。
 */
export function splitTaskReminder(body: string): { body: string; at: string } | null {
  for (const match of body.matchAll(REMINDER_GLOBAL_PATTERN)) {
    const at = `${match[1]} ${match[2]}`
    const start = match.index ?? 0
    if (parseReminderAt(at) === null) continue
    if ((body.slice(0, start).match(/`/gu)?.length ?? 0) % 2 === 1) continue
    const end = start + match[0].length
    const before = body.slice(0, start)
    const after = body.slice(end)
    const joined = before.endsWith(" ") && (after === "" || after.startsWith(" "))
      ? before.slice(0, -1) + after
      : before + after.replace(/^ /u, "")
    return { body: joined.replace(/\s+$/u, ""), at }
  }
  return null
}
