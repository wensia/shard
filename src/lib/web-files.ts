/**
 * 网页端替代桌面原生对话框的两件事：用浏览器选文件、把字节存成下载。
 * 桌面仍走 Tauri 的系统对话框（能拿到本机路径、写到用户选的位置）。
 */

export const IMAGE_FILE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/heic,image/heif,image/avif"

/** 打开浏览器的文件选择框；取消时返回空数组。 */
export function pickFiles(options: { accept?: string; multiple?: boolean } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = options.accept ?? ""
    input.multiple = Boolean(options.multiple)
    input.style.display = "none"
    const finish = (files: File[]) => {
      input.remove()
      resolve(files)
    }
    input.addEventListener("change", () => finish(Array.from(input.files ?? [])), { once: true })
    input.addEventListener("cancel", () => finish([]), { once: true })
    document.body.append(input)
    input.click()
  })
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = fileName
  anchor.rel = "noreferrer"
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function fileBytes(file: File) {
  return new Uint8Array(await file.arrayBuffer())
}
