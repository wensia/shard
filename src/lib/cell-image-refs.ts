/**
 * 表格单元格里的图片引用：每个非空行一张，写 vault 相对路径（`assets/…`、
 * `notes/证件/营业执照.jpg`）、旧附件引用 `shard-attachment:<sha256>`，或带图片扩展名的
 * https 地址。规则与 `shard-core::image_refs::csv_cell_image_references` 一致。
 *
 * 只做纯文本判断，不碰表格组件：碎片卡片里的嵌入表格也用它。
 */
const IMAGE_EXTENSION = /\.(?:avif|gif|heic|heif|jpe?g|png|svg|webp)$/iu
const SCHEME = /^[a-z][a-z\d+.-]*:/iu
const ATTACHMENT = /^shard-attachment:[a-f\d]{64}$/iu

export function isLocalImageRef(value: string) {
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes("\\")) return false
  if (ATTACHMENT.test(trimmed)) return true
  if (SCHEME.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("#")) return false
  const path = trimmed.replace(/^\.\//u, "")
  if (path.split("/").some((part) => part === "" || part === "." || part === "..")) return false
  const name = path.split("/").pop() ?? ""
  return path.startsWith("assets/") || (IMAGE_EXTENSION.test(name) && !name.startsWith("."))
}

export function isRemoteImageRef(value: string) {
  const trimmed = value.trim()
  if (!/^https?:\/\/\S+$/iu.test(trimmed)) return false
  try {
    const url = new URL(trimmed)
    return IMAGE_EXTENSION.test(url.pathname)
  } catch {
    return false
  }
}

/** 每个非空行都是图片引用时返回这些引用（去掉 `./`），否则 null。 */
export function parseCellImageRefs(value: string): string[] | null {
  if (!value || value.length > 8_192) return null
  const lines = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0 || lines.length > 12) return null
  if (!lines.every((line) => isLocalImageRef(line) || isRemoteImageRef(line))) return null
  return lines.map((line) => line.replace(/^\.\//u, ""))
}
