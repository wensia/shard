import { describe, it, expect } from 'vitest'
import { CHUNK_CHARS, FIRST_CHUNK_CHARS, sentences, speechChunks } from './voice-text'
const length = (text: string) => Array.from(text).length
describe('朗读正文', () => {
  it('只读正文，保留链接文字，忽略元数据、代码和图片', () => {
    const chunks = speechChunks({ format: 'markdown', text: '---\nsecret: hidden\n---\n# 标题\n\n[显示文字](https://example.com/private)\n\n![照片](secret.png)\n\n```js\nsecretCode()\n```\n\n- 列表内容' })
    const text = chunks.join('')
    expect(text).toContain('标题'); expect(text).toContain('显示文字'); expect(text).toContain('列表内容')
    for (const secret of ['hidden', 'https://', 'secret.png', 'secretCode']) expect(text).not.toContain(secret)
  })
  it('不截断长文和Unicode字符，首段最多80字符、其余每段最多400字符', () => {
    const text = '你好😀'.repeat(600)
    const chunks = speechChunks({ text, format: 'text' })
    expect(chunks.join('')).toBe(text)
    expect(length(chunks[0])).toBeLessThanOrEqual(FIRST_CHUNK_CHARS)
    expect(chunks.slice(1).every(chunk => length(chunk) <= CHUNK_CHARS)).toBe(true)
  })
  it('空正文返回空数组', () => expect(speechChunks({ text: ' \n ', format: 'text' })).toEqual([]))
  it('首句单独成段以尽快出声，之后在句号处分段', () => {
    const first = '第一句很短。'; const a = '甲'.repeat(300) + '。'; const b = '乙'.repeat(300) + '。'
    expect(speechChunks({ text: first + a + b, format: 'text' })).toEqual([first, a, b])
  })
  it('首句过长时在逗号处断开首段', () => {
    const head = '甲'.repeat(50) + '，'; const tail = '乙'.repeat(60) + '。'
    expect(speechChunks({ text: head + tail, format: 'text' })).toEqual([head, tail])
  })
  it('分号、英文句点都可断句；小数、网址和句末引号不被拆开', () => {
    expect(sentences('版本 3.14 已发布；详见 shard.app/notes。He said "done." Then left'))
      .toEqual(['版本 3.14 已发布；', '详见 shard.app/notes。', 'He said "done."', ' Then left'])
  })
})
