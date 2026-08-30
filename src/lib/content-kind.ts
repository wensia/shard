export const TYPE_TAGS = ["note"] as const

export type ContentKind = "fragment" | "note"

const NOTE_TITLE_MAX_LENGTH = 48

export function isTypeTag(tag: string) {
  return (TYPE_TAGS as readonly string[]).includes(tag)
}

export function deriveKind(tags: readonly string[]): ContentKind {
  return tags.includes("note") ? "note" : "fragment"
}

export function deriveNoteTitle(content: string) {
  const lines = content.split(/\r?\n/u)
  const heading = lines
    .map((line) => line.match(/^ {0,3}#\s+(.+?)\s*$/u)?.[1] ?? "")
    .find((title) => title.trim().length > 0)

  if (heading) {
    return heading
      .replace(/\s+#+\s*$/u, "")
      .trim()
  }

  const firstLine = lines.find((line) => line.trim().length > 0)?.trim() ?? ""
  if (firstLine.length <= NOTE_TITLE_MAX_LENGTH) return firstLine

  return `${firstLine.slice(0, NOTE_TITLE_MAX_LENGTH).trimEnd()}…`
}
