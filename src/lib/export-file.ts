import { invoke, isTauri } from "@tauri-apps/api/core"

import { DESKTOP_RUNTIME_MESSAGE } from "@/lib/api"

/** 把导出内容原子写到用户选择的 vault 外路径；原始字节 IPC，避免大文件在 UI 线程序列化成 number[]。 */
export async function writeExportFile(path: string, bytes: Uint8Array): Promise<void> {
  if (!isTauri()) throw new Error(DESKTOP_RUNTIME_MESSAGE)
  await invoke<void>("write_export_file", bytes, { headers: { "x-shard-export-path": encodeURIComponent(path) } })
}
