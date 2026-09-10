import { invoke, isTauri } from "@tauri-apps/api/core"
import { DESKTOP_RUNTIME_MESSAGE, getApiErrorMessage } from "@/lib/api"
import type { CanvasFile, CanvasReadResult } from "./model"
import { decodeCanvasResponse, encodeCanvasRequest } from "./codec"
import type { DiagramDocumentSummary } from "@/types"

export interface CanvasSplitResult {
  documents: DiagramDocumentSummary[]
  indexPath: string
}

export async function splitCanvas(path: string, expectedRevision: number, lastSavedHash: string) {
  if (!isTauri()) throw new Error(DESKTOP_RUNTIME_MESSAGE)
  try {
    return await invoke<CanvasSplitResult>("split_canvas", { path, expectedRevision, lastSavedHash })
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
  if (!isTauri()) throw new Error(DESKTOP_RUNTIME_MESSAGE)
  try {
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
