export type SearchProjectionBlock =
  | { kind: "text"; text: string }
  | {
      kind: "documentOnly"
      reason: "codeBlock" | "embed"
      text: string
    }

export interface SearchProjection {
  blocks: readonly SearchProjectionBlock[]
  documentOnlyText: string
  revealableText: string
  searchableText: string
  version: 1
}

interface InlineProjection {
  embeds: string[]
  text: string
}

interface Fence {
  length: number
  marker: "`" | "~"
}

function normalizeNewlines(text: string) {
  return text.replace(/\r\n?/gu, "\n")
}

function fenceAt(line: string): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line)
  if (!match) return null
  return {
    length: match[1].length,
    marker: match[1][0] as Fence["marker"],
  }
}

function closesFence(line: string, fence: Fence) {
  const trimmed = line.replace(/^ {0,3}/u, "")
  let length = 0
  while (trimmed[length] === fence.marker) length += 1
  return length >= fence.length && trimmed.slice(length).trim() === ""
}

function isTableDelimiter(line: string) {
  const cells = line
    .trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
  return (
    cells.length > 0 &&
    cells.every((cell) => /^\s*:?-{2,}:?\s*$/u.test(cell))
  )
}

function splitTableCells(line: string) {
  const cells: string[] = []
  let cell = ""
  let codeRun = 0

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === "\\" && line[index + 1] === "|") {
      cell += "|"
      index += 1
      continue
    }
    if (char === "`") {
      let run = 1
      while (line[index + run] === "`") run += 1
      codeRun = codeRun === run ? 0 : codeRun === 0 ? run : codeRun
      cell += "`".repeat(run)
      index += run - 1
      continue
    }
    if (char === "|" && codeRun === 0) {
      cells.push(cell.trim())
      cell = ""
      continue
    }
    cell += char
  }
  cells.push(cell.trim())

  if (cells[0] === "") cells.shift()
  if (cells[cells.length - 1] === "") cells.pop()
  return cells
}

function stripBlockPrefix(line: string) {
  let text = line
  while (/^ {0,3}>[ \t]?/u.test(text)) {
    text = text.replace(/^ {0,3}>[ \t]?/u, "")
  }
  text = text.replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/u, "")
  text = text.replace(/^ {0,3}(?:[-+*]|\d+[.)])[ \t]+/u, "")
  text = text.replace(/^\[[ xX]\](?:[ \t]+|$)/u, "")
  text = text.replace(/[ \t]+#+[ \t]*$/u, "")
  text = text.replace(/(?: {2,}|\\)$/u, "")
  return text.trim()
}

function delimiterCanOpen(chars: string[], index: number, length: number) {
  const before = chars[index - 1]
  const after = chars[index + length]
  if (!after || /\s/u.test(after)) return false
  if (
    chars[index] === "_" &&
    before &&
    /[\p{L}\p{N}]/u.test(before) &&
    /[\p{L}\p{N}]/u.test(after)
  ) {
    return false
  }
  return true
}

function delimiterCanClose(chars: string[], index: number, length: number) {
  const before = chars[index - 1]
  const after = chars[index + length]
  if (!before || /\s/u.test(before)) return false
  if (
    chars[index] === "_" &&
    after &&
    /[\p{L}\p{N}]/u.test(before) &&
    /[\p{L}\p{N}]/u.test(after)
  ) {
    return false
  }
  return true
}

function hasMatchingDelimiter(
  chars: string[],
  index: number,
  marker: string,
  length: number,
  direction: 1 | -1
) {
  for (
    let cursor = index + direction;
    cursor >= 0 && cursor < chars.length;
    cursor += direction
  ) {
    if (chars[cursor] !== marker) continue
    let run = 1
    while (chars[cursor + run] === marker) run += 1
    if (run !== length) continue
    if (
      direction === 1
        ? delimiterCanClose(chars, cursor, run)
        : delimiterCanOpen(chars, cursor, run)
    ) {
      return true
    }
  }
  return false
}

function projectInline(input: string): InlineProjection {
  const chars = Array.from(input)
  const embeds: string[] = []
  let text = ""

  for (let index = 0; index < chars.length; ) {
    if (chars[index] === "\\" && chars[index + 1]) {
      text += chars[index + 1]
      index += 2
      continue
    }

    if (chars[index] === "`") {
      let run = 1
      while (chars[index + run] === "`") run += 1
      let close = index + run
      while (close < chars.length) {
        if (
          chars[close] === "`" &&
          chars.slice(close, close + run).every((char) => char === "`") &&
          chars[close + run] !== "`"
        ) {
          break
        }
        close += 1
      }
      if (close < chars.length) {
        text += chars.slice(index + run, close).join("")
        index = close + run
        continue
      }
    }

    const rest = chars.slice(index).join("")
    const wikiEmbed = /^!\[\[([^\]]+)\]\]/u.exec(rest)
    if (wikiEmbed) {
      const [target, label] = wikiEmbed[1].split("|")
      const visible = (label ?? target).trim()
      if (visible) embeds.push(visible)
      index += Array.from(wikiEmbed[0]).length
      continue
    }

    const wikiLink = /^\[\[([^\]]+)\]\]/u.exec(rest)
    if (wikiLink) {
      const [target, label] = wikiLink[1].split("|")
      text += (label ?? target).trim()
      index += Array.from(wikiLink[0]).length
      continue
    }

    const image = /^!\[([^\]]*)\]\([^)]*\)/u.exec(rest)
    if (image) {
      const visible = projectInline(image[1]).text.trim()
      if (visible) embeds.push(visible)
      index += Array.from(image[0]).length
      continue
    }

    const link = /^\[([^\]]+)\]\([^)]*\)/u.exec(rest)
    if (link) {
      text += projectInline(link[1]).text
      index += Array.from(link[0]).length
      continue
    }

    if (chars[index] === "<") {
      const close = chars.indexOf(">", index + 1)
      if (close >= 0) {
        const content = chars.slice(index + 1, close).join("")
        if (/^(?:https?:\/\/|mailto:)/iu.test(content)) {
          text += content.replace(/^mailto:/iu, "")
        } else if (/^\/?[A-Za-z][^>]*$/u.test(content)) {
          // HTML 标签只承担展示结构，不进入检索文本。
        } else {
          text += chars.slice(index, close + 1).join("")
        }
        index = close + 1
        continue
      }
    }

    if (chars[index] === "*" || chars[index] === "_" || chars[index] === "~") {
      const marker = chars[index]
      let run = 1
      while (chars[index + run] === marker) run += 1
      const supported = marker !== "~" || run >= 2
      const isDelimiter =
        supported &&
        ((delimiterCanOpen(chars, index, run) &&
          hasMatchingDelimiter(chars, index, marker, run, 1)) ||
          (delimiterCanClose(chars, index, run) &&
            hasMatchingDelimiter(chars, index, marker, run, -1)))
      if (isDelimiter) {
        index += run
        continue
      }
    }

    text += chars[index]
    index += 1
  }

  return { embeds, text: text.trim() }
}

export function projectSearchText(markdown: string): SearchProjection {
  const lines = normalizeNewlines(markdown).split("\n")
  const tableRows = new Set<number>()
  for (let index = 0; index < lines.length; index += 1) {
    if (!isTableDelimiter(lines[index])) continue
    if (index > 0 && lines[index - 1].includes("|")) tableRows.add(index - 1)
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (!lines[cursor].includes("|") || lines[cursor].trim() === "") break
      tableRows.add(cursor)
    }
  }

  const blocks: SearchProjectionBlock[] = []
  let fence: Fence | null = null
  let fenceLines: string[] = []
  let mayMerge = false

  const append = (block: SearchProjectionBlock) => {
    if (!block.text) return
    const previous = blocks[blocks.length - 1]
    if (
      mayMerge &&
      previous?.kind === block.kind &&
      (previous.kind === "text" ||
        (block.kind === "documentOnly" && previous.reason === block.reason))
    ) {
      blocks[blocks.length - 1] = { ...previous, text: `${previous.text}\n${block.text}` }
    } else {
      blocks.push(block)
    }
    mayMerge = true
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (fence) {
      if (closesFence(line, fence)) {
        append({
          kind: "documentOnly",
          reason: "codeBlock",
          text: fenceLines.join("\n").replace(/^\n+|\n+$/gu, ""),
        })
        fence = null
        fenceLines = []
        mayMerge = false
      } else {
        fenceLines.push(line)
      }
      continue
    }

    const openingFence = fenceAt(line)
    if (openingFence) {
      fence = openingFence
      fenceLines = []
      mayMerge = false
      continue
    }

    if (isTableDelimiter(line)) {
      mayMerge = false
      continue
    }

    const inline = tableRows.has(index)
      ? splitTableCells(line).map(projectInline)
      : [projectInline(stripBlockPrefix(line))]
    const text = inline.map((part) => part.text).filter(Boolean).join("\t")
    const embeds = inline.flatMap((part) => part.embeds)

    if (text) append({ kind: "text", text })
    for (const embed of embeds) {
      append({ kind: "documentOnly", reason: "embed", text: embed })
    }
    if (!text && embeds.length === 0) mayMerge = false
  }

  if (fence && fenceLines.length > 0) {
    append({
      kind: "documentOnly",
      reason: "codeBlock",
      text: fenceLines.join("\n").replace(/^\n+|\n+$/gu, ""),
    })
  }

  const revealableText = blocks
    .filter((block) => block.kind === "text")
    .map((block) => block.text)
    .join("\n")
  const documentOnlyText = blocks
    .filter((block) => block.kind === "documentOnly")
    .map((block) => block.text)
    .join("\n")

  return {
    blocks,
    documentOnlyText,
    revealableText,
    searchableText: blocks.map((block) => block.text).join("\n"),
    version: 1,
  }
}
