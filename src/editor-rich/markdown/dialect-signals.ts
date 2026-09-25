/**
 * 粘贴进来的纯文本「像不像 Shard 方言」。
 *
 * 命中任意一条特征就按方言解析成组件（产品框架 §4「粘贴 Markdown 文本」）；
 * 没命中就走 ProseMirror 的默认纯文本粘贴，免得把一段普通中文里的星号
 * 当成语法。判断只看特征，不做完整解析——解析由转换层负责。
 */
const DIALECT_SIGNALS: readonly RegExp[] = [
  // 行首：无序 / 有序列表（含任务项）、标题、围栏、引用、表格管道。
  /^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+/mu,
  /^[ \t]{0,3}#{1,6}[ \t]+\S/mu,
  /^[ \t]{0,3}```/mu,
  /^[ \t]{0,3}>[ \t]+\S/mu,
  /^[ \t]{0,3}\|.*\|[ \t]*$/mu,
  // 行内：粗体、高亮、双链、标签。
  /\*\*[^*\n]+\*\*/u,
  /==[^=\n]+==/u,
  /\[\[[^\]\n]+\]\]/u,
  /(?:^|[\s(（[【])#[^\s#]+/mu,
]

export function looksLikeShardMarkdown(text: string) {
  if (!text.trim()) return false
  return DIALECT_SIGNALS.some((pattern) => pattern.test(text))
}
