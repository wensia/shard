export function formatBytes(size: number) {
  if (!Number.isFinite(size) || size < 0) return "0 B"
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`
  }

  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function formatModifiedAt(modifiedAt: string) {
  if (!modifiedAt) return ""

  const date = new Date(modifiedAt)
  if (Number.isNaN(date.getTime())) return ""

  return date.toLocaleString("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    year: "numeric",
  })
}
