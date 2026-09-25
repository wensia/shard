export interface FrontmatterSplit {
  /** 剥离 Frontmatter 之后的正文，换行统一为 `\n`。 */
  body: string
  /** 含首尾 `---` 的 Frontmatter 原文，没有时为 null。 */
  frontmatter: string | null
}

const FRONTMATTER_FENCE = "---"

/** 文件头 Frontmatter 原样剥离：不进入文档模型，也不做 YAML 解析。 */
export function splitFrontmatter(markdown: string): FrontmatterSplit {
  const normalized = markdown.replace(/\r\n?/gu, "\n")
  const lines = normalized.split("\n")
  if (lines[0]?.trimEnd() !== FRONTMATTER_FENCE) {
    return { body: normalized, frontmatter: null }
  }

  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trimEnd() !== FRONTMATTER_FENCE) continue
    return {
      body: lines.slice(index + 1).join("\n").replace(/^\n+/u, ""),
      frontmatter: lines.slice(0, index + 1).join("\n"),
    }
  }

  // 没有闭合 `---` 时首行是分割线，不是 Frontmatter。
  return { body: normalized, frontmatter: null }
}

/** 回写：Frontmatter 原文在前，与正文之间固定一个空行。 */
export function joinFrontmatter(body: string, frontmatter: string | null) {
  if (!frontmatter) return body
  return body ? `${frontmatter}\n\n${body}` : frontmatter
}
