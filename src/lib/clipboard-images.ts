interface ClipboardImageEvent {
  clipboardData: DataTransfer | null
}

export function getClipboardImageFiles(event: ClipboardImageEvent) {
  const clipboardData = event.clipboardData
  if (!clipboardData) return []

  const itemFiles = Array.from(clipboardData.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file))

  if (itemFiles.length > 0) return itemFiles

  return Array.from(clipboardData.files).filter((file) =>
    file.type.startsWith("image/")
  )
}
