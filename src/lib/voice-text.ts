import type { JSONContent } from '@tiptap/core'
import { parseShardMarkdown } from '@/editor-rich/markdown/parse'
export type VoiceContent = { text: string; format: 'markdown' | 'text' }
const skipped = new Set(['codeBlock', 'image', 'csvEmbed', 'shardBlock', 'rawBlock', 'tag', 'reminder'])
export function spokenDocument(node: JSONContent): string {
  if (skipped.has(node.type ?? '')) return ''
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  if (node.type === 'wikilink') return String(node.attrs?.alias ?? node.attrs?.target ?? '')
  const text = (node.content ?? []).map(spokenDocument).join('')
  return ['paragraph', 'heading', 'tableCell', 'tableHeader', 'tableRow'].includes(node.type ?? '') ? `${text}\n` : text
}

/** Synthesis is not streamed, so the first segment is kept short: playback starts after one sentence, not 400 characters. */
export const FIRST_CHUNK_CHARS = 80
export const CHUNK_CHARS = 400
const SENTENCE_END = new Set(Array.from('。！？!?；;…\n'))
const CLOSERS = new Set(Array.from('”’」』）》】)]"\''))
const SOFT_BREAK = new Set(Array.from('，,、：:—'))

/** Splits after sentence punctuation, keeping trailing quotes/brackets; "." ends a sentence only before whitespace, so 3.14 and URLs stay whole. */
export function sentences(text: string): string[] {
  const chars = Array.from(text)
  const out: string[] = []
  let current = ''
  let ended = false
  chars.forEach((char, index) => {
    if (ended && !SENTENCE_END.has(char) && !CLOSERS.has(char)) { out.push(current); current = ''; ended = false }
    current += char
    const next = chars[index + 1]
    if (SENTENCE_END.has(char) || (char === '.' && (next === undefined || CLOSERS.has(next) || /\s/u.test(next)))) ended = true
  })
  if (current) out.push(current)
  return out
}

/** Cuts an over-long sentence at the last comma or space in the back half of the limit, else at the limit. */
function cut(piece: string, limit: number): [string, string] {
  const chars = Array.from(piece)
  let at = limit
  for (let index = limit; index > Math.ceil(limit / 2); index--) {
    const char = chars[index - 1]
    if (SOFT_BREAK.has(char) || /\s/u.test(char)) { at = index; break }
  }
  return [chars.slice(0, at).join(''), chars.slice(at).join('')]
}

const length = (text: string) => Array.from(text).length

export function speechChunks(content: VoiceContent): string[] {
  const text = (content.format === 'markdown' ? spokenDocument(parseShardMarkdown(content.text).doc) : content.text).trim()
  const queue = sentences(text)
  const chunks: string[] = []
  let current = ''
  while (queue.length) {
    const piece = queue.shift()!
    const limit = chunks.length ? CHUNK_CHARS : FIRST_CHUNK_CHARS
    if (length(current + piece) <= limit) { current += piece; continue }
    if (current.trim()) { chunks.push(current.trim()); current = ''; queue.unshift(piece); continue }
    current = ''
    const [head, rest] = cut(piece, limit)
    if (head.trim()) chunks.push(head.trim())
    if (rest) queue.unshift(rest)
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks
}
