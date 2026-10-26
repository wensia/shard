import { invoke } from "@tauri-apps/api/core"
import { getApiErrorMessage } from "@/lib/api"
import { transport } from "@/lib/transport"
import type { CanvasFile, CanvasReadResult } from "./model"
import { decodeCanvasResponse, encodeCanvasRequest } from "./codec"
import type { DiagramDocumentSummary } from "@/types"

export interface CanvasSplitResult {
  documents: DiagramDocumentSummary[]
  indexPath: string
}

export async function splitCanvas(path: string, expectedRevision: number, lastSavedHash: string) {
  try {
    return await transport().invoke<CanvasSplitResult>("split_canvas", { path, expectedRevision, lastSavedHash })
  } catch (error) {
    throw new Error(getApiErrorMessage(error))
  }
}

export interface CanvasWriteRequest {
  path: string
  file: CanvasFile
  expectedRevision: number
  lastSavedHash: string
}

async function canvasInvoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    // 以服务器为真相（网页、连接了服务器的桌面）：普通 JSON 请求；本地桌面：Worker 编码成字节走二进制 IPC，
    // 大画布不在 UI 线程序列化。
    if (transport().kind !== "tauri") return await transport().invoke<T>(command, args)
    const request = await encodeCanvasRequest(args)
    return await decodeCanvasResponse<T>(await invoke<ArrayBuffer>(command, request))
  } catch (error) {
    throw new Error(getApiErrorMessage(error))
  }
}

export function createCanvas(parentPath: string, title: string, file: CanvasFile) {
  return canvasInvoke<CanvasReadResult>("create_canvas", { parentPath, title, file })
}

export function readCanvas(path: string) {
  return canvasInvoke<CanvasReadResult>("read_canvas", { path })
}

export function writeCanvas(request: CanvasWriteRequest) {
  return canvasInvoke<CanvasReadResult>("write_canvas", { ...request })
}
