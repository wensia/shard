import { readCanvas } from "@/features/canvas/api"
import type { CanvasReadResult } from "@/features/canvas/model"
import { readTable } from "@/features/tables/api"
import type { TableReadResult } from "@/features/tables/model"
import { readGraphFragment, readMindMap, type GraphFragmentResult } from "@/lib/api"
import { openDatasetEditor } from "@/features/datasets/open-dataset"
import { readSearchTarget } from "@/lib/search-api"
import type {
  ReadSearchTargetResponse,
  SearchContext,
  SearchHit,
  SearchRevealHandle,
  SearchTarget,
} from "@/lib/search-contract"
import type { SearchNavigationHost } from "@/lib/search-navigation"
import type { MindMapReadResult } from "@/types"

type Ready = {
  status: "ready"
  revision: string | null
  reveal: SearchRevealHandle | null
}

export interface SearchTargetRouterAdapters {
  flushBeforeLeave(): Promise<boolean>
  openMarkdown(
    response: ReadSearchTargetResponse,
    requestId: string,
    signal: AbortSignal
  ): Promise<{ reveal: SearchRevealHandle | null }>
  openMindMap(
    target: SearchTarget,
    result: MindMapReadResult,
    requestId: string,
    signal: AbortSignal
  ): Promise<{ reveal: SearchRevealHandle | null }>
  openCanvas(
    target: SearchTarget,
    result: CanvasReadResult,
    requestId: string,
    signal: AbortSignal
  ): Promise<{ reveal: SearchRevealHandle | null }>
  openGraphFragment(
    target: SearchTarget,
    result: GraphFragmentResult,
    requestId: string,
    signal: AbortSignal
  ): Promise<{ reveal: SearchRevealHandle | null }>
  openTable(
    target: SearchTarget,
    result: TableReadResult,
    requestId: string,
    signal: AbortSignal
  ): Promise<{ reveal: SearchRevealHandle | null }>
}

export interface CreateSearchTargetRouterOptions {
  adapters: SearchTargetRouterAdapters
  context: SearchContext | null
  hit: SearchHit
}

/** Reads the target at navigation time, then delegates mounting to its host. */
export function createSearchTargetRouter({
  adapters,
  context,
  hit,
}: CreateSearchTargetRouterOptions): SearchNavigationHost {
  return {
    flushBeforeLeave: adapters.flushBeforeLeave,
    async openTarget(target, requestId, signal) {
      assertCurrentTarget(hit, target)
      throwIfAborted(signal)

      if (isMarkdown(target)) {
        const response = await readSearchTarget({
          clientRequestId: requestId,
          context,
          expectedRevision: hit.revision,
          expectedVaultPath: target.vaultPath,
          target,
        })
        throwIfAborted(signal)
        if (
          response.clientRequestId !== requestId ||
          response.target.key !== target.key
        ) {
          throw { code: "targetChanged" }
        }
        const opened = await adapters.openMarkdown(
          response,
          requestId,
          signal
        )
        return ready(response.revision, opened.reveal)
      }

      if (target.kind === "mindmap") {
        if (!target.objectId) throw { code: "unsupportedTarget" }
        const result = await readMindMap(target.objectId)
        throwIfAborted(signal)
        const opened = await adapters.openMindMap(
          target,
          result,
          requestId,
          signal
        )
        return ready(String(result.file.revision), opened.reveal)
      }

      if (target.kind === "flowchart" && target.path.endsWith(".md")) {
        if (!target.objectId) throw { code: "unsupportedTarget" }
        const result = await readGraphFragment(target.objectId)
        throwIfAborted(signal)
        const opened = await adapters.openGraphFragment(
          target,
          result,
          requestId,
          signal
        )
        return ready(result.fragment.fileSha ?? result.fragment.updatedAt, opened.reveal)
      }

      if (target.kind === "canvas" || target.kind === "flowchart") {
        const result = await readCanvas(target.path)
        throwIfAborted(signal)
        const opened = await adapters.openCanvas(
          target,
          result,
          requestId,
          signal
        )
        return ready(String(result.file.revision), opened.reveal)
      }

      if (target.kind === "table") {
        const result = await readTable({
          path: target.path,
          ...(target.objectId ? { expectedTableId: target.objectId } : {}),
        })
        throwIfAborted(signal)
        const opened = await adapters.openTable(
          target,
          result,
          requestId,
          signal
        )
        return ready(String(result.revision), opened.reveal)
      }

      if (target.kind === "csv") {
        openDatasetEditor(target.path)
        throwIfAborted(signal)
        return { status: "externalAccepted" }
      }

      throw { code: "unsupportedTarget" }
    },
  }
}

function isMarkdown(target: SearchTarget) {
  return (
    target.kind === "fragment" ||
    target.kind === "note" ||
    target.kind === "outline" ||
    target.kind === "document"
  )
}

function assertCurrentTarget(hit: SearchHit, target: SearchTarget) {
  if (hit.target.key !== target.key) throw { code: "targetChanged" }
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("Navigation aborted", "AbortError")
}

function ready(
  revision: string | null,
  reveal: SearchRevealHandle | null
): Ready {
  return { status: "ready", revision, reveal }
}
