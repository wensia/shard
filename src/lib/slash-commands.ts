export type SlashCommandId =
  | "codeblock"
  | "divider"
  | "document"
  | "heading1"
  | "heading2"
  | "heading3"
  | "heading4"
  | "image"
  | "memo"
  | "mindmap"
  | "ordered"
  | "outline"
  | "quote"
  | "table"
  | "tag"
  | "task"
  | "unordered"

export interface SlashCommand {
  /** 主别名，作为候选项右侧的提示徽标 */
  hint: string
  id: SlashCommandId
  /** 中文名、英文名与拼音首字母，全部小写后做 includes 匹配 */
  keywords: readonly string[]
  label: string
}

export interface ActiveSlashCommand {
  query: string
  slashStart: number
}

const MAX_SLASH_QUERY_LENGTH = 24

/**
 * 备忘卡片：GFM 任务项加一行缩进细节，不发明新语法（产品框架 §5.2）。
 * 富文本插入的是空标题段与空细节段，这两句是它们的占位提示。
 */
export const MEMO_CARD_TITLE_PLACEHOLDER = "备忘标题"
export const MEMO_CARD_DETAIL_PLACEHOLDER = "补充细节"

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    // 围栏块命令只叫「导图块」：关键词里不留「大纲」「outline」「dg」，
    // 让 `/大纲` 专指内容类型命令（产品框架 §11 末条）。
    hint: "mindmap",
    id: "mindmap",
    keywords: ["导图块", "导图", "dtk", "dt", "mindmap", "mind"],
    label: "导图块",
  },
  {
    hint: "todo",
    id: "task",
    keywords: ["任务列表", "任务", "待办", "rwlb", "rw", "db", "task", "todo", "checkbox"],
    label: "任务列表",
  },
  {
    hint: "list",
    id: "unordered",
    keywords: ["无序列表", "无序", "列表", "wxlb", "wx", "lb", "list", "bullet", "ul"],
    label: "无序列表",
  },
  {
    hint: "ordered",
    id: "ordered",
    keywords: ["有序列表", "有序", "编号", "yxlb", "yx", "bh", "ordered", "number", "ol"],
    label: "有序列表",
  },
  {
    hint: "table",
    id: "table",
    keywords: ["表格", "bg", "table", "grid"],
    label: "表格",
  },
  {
    hint: "divider",
    id: "divider",
    keywords: ["分割线", "分隔线", "分割", "fgx", "fg", "divider", "hr", "rule"],
    label: "分割线",
  },
  {
    hint: "tag",
    id: "tag",
    keywords: ["标签", "bq", "tag", "hash"],
    label: "标签",
  },
  {
    hint: "image",
    id: "image",
    keywords: ["图片", "插图", "tp", "image", "img", "picture", "photo"],
    label: "图片",
  },
  {
    hint: "memo",
    id: "memo",
    keywords: ["备忘卡片", "备忘", "bwkp", "bw", "memo", "card"],
    label: "备忘卡片",
  },
  {
    hint: "outline",
    id: "outline",
    keywords: ["大纲", "dg", "outline"],
    label: "大纲",
  },
  {
    hint: "document",
    id: "document",
    keywords: ["文档", "wd", "doc", "document"],
    label: "文档",
  },
  // 以下是文档档专属的块级命令（产品框架 §2），碎片与大纲的编辑面不展示。
  {
    hint: "h1",
    id: "heading1",
    keywords: ["标题1", "一级标题", "bt1", "h1", "heading1"],
    label: "标题 1",
  },
  {
    hint: "h2",
    id: "heading2",
    keywords: ["标题2", "二级标题", "bt2", "h2", "heading2"],
    label: "标题 2",
  },
  {
    hint: "h3",
    id: "heading3",
    keywords: ["标题3", "三级标题", "bt3", "h3", "heading3"],
    label: "标题 3",
  },
  {
    hint: "h4",
    id: "heading4",
    keywords: ["标题4", "四级标题", "bt4", "h4", "heading4"],
    label: "标题 4",
  },
  {
    hint: "quote",
    id: "quote",
    keywords: ["引用", "yy", "quote", "blockquote"],
    label: "引用",
  },
  {
    hint: "code",
    id: "codeblock",
    keywords: ["代码块", "代码", "dmk", "code", "codeblock"],
    label: "代码块",
  },
]

/**
 * 文档档专属命令：标题 1–4、引用、代码块。基础档（碎片、大纲）照常解析与保存
 * 这些结构，只是不提供输入入口，与输入前缀的档位白名单同一口径。
 */
export function isDocumentTierSlashCommand(id: SlashCommandId) {
  return (
    id === "heading1" ||
    id === "heading2" ||
    id === "heading3" ||
    id === "heading4" ||
    id === "quote" ||
    id === "codeblock"
  )
}

/**
 * 内容类型命令（`/大纲`、`/文档`）改变的是「正在创建什么」，属于宿主状态而不是
 * 正文编辑：纯函数层没有产物，由速记框接手。只有能创建新碎片的编辑面才提供它们，
 * 行内编辑、禅模式与资料库编辑器不展示。
 */
export function isContentTypeSlashCommand(id: SlashCommandId) {
  return id === "outline" || id === "document"
}

/**
 * `/` 只在行首或空白之后才算命令触发点，这样 `http://`、`a/b` 这类路径写法
 * 不会误弹菜单；query 不含空白且不超过 24 字符，避免整段正文被当成查询。
 */
export function getActiveSlashCommand(
  value: string,
  cursor: number
): ActiveSlashCommand | null {
  const beforeCursor = value.slice(0, cursor)
  const slashStart = beforeCursor.lastIndexOf("/")
  if (slashStart < 0) return null

  const previous = slashStart > 0 ? value[slashStart - 1] : ""
  if (previous && !/\s/u.test(previous)) return null

  const query = beforeCursor.slice(slashStart + 1)
  if (/[\s/]/u.test(query)) return null
  if (query.length > MAX_SLASH_QUERY_LENGTH) return null

  return { query, slashStart }
}

export function filterSlashCommands(query: string): SlashCommand[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return [...SLASH_COMMANDS]

  return SLASH_COMMANDS.filter((command) =>
    command.keywords.some((keyword) => keyword.toLowerCase().includes(normalized))
  )
}
