import { useCallback, useEffect, useState } from "react"

import { DownloadIcon, HistoryIcon, Loader2Icon, XIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { notify } from "@/lib/notify"

import {
  OPEN_HISTORY_EVENT,
  REVISION_REASON_LABEL,
  listRevisions,
  readRevisionBytes,
  readRevisionText,
  readsRevisionsViaDevice,
  restoreRevision,
  revisionPreviewKind,
  revisionUrl,
  saveRevisionCopy,
  type OpenHistoryDetail,
  type RevisionInfo,
} from "./history-api"
import styles from "./history.module.css"

export function formatRevisionTime(value: string) {
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) return value
  return time.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
}

export function formatSize(size: number | null) {
  if (size === null) return ""
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function isStaleBase(error: unknown) {
  return String(error).includes("STALE_BASE")
}

/** 图片修订的地址：网页直接用服务器地址；桌面连接服务器时经 Rust 读字节，换成 blob 地址。 */
function useRevisionImageSrc(revision: RevisionInfo, enabled: boolean) {
  const viaDevice = readsRevisionsViaDevice()
  const [src, setSrc] = useState<string | null>(viaDevice ? null : revisionUrl(revision.revId))
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!enabled || !viaDevice) {
      setSrc(revisionUrl(revision.revId))
      return
    }
    let cancelled = false
    let objectUrl: string | null = null
    setSrc(null)
    setError(null)
    readRevisionBytes(revision.revId)
      .then(({ bytes, contentType }) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: contentType ?? "" }))
        setSrc(objectUrl)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(String(reason))
      })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [enabled, revision.revId, viaDevice])
  return { src, error }
}

function RevisionPreview({ revision }: { revision: RevisionInfo }) {
  const kind = revisionPreviewKind(revision.path)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const image = useRevisionImageSrc(revision, kind === "image" && Boolean(revision.sha))

  useEffect(() => {
    if (kind !== "text" || !revision.sha) return
    let cancelled = false
    setText(null)
    setError(null)
    readRevisionText(revision.revId)
      .then((value) => {
        if (!cancelled) setText(value)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(String(reason))
      })
    return () => {
      cancelled = true
    }
  }, [kind, revision.revId, revision.sha])

  if (!revision.sha) return <p className={styles.previewNote}>这一条记录的是删除时刻，没有内容。</p>
  if (kind === "image") {
    if (image.error) return <p className={styles.previewNote}>{image.error}</p>
    if (!image.src) {
      return (
        <p className={styles.previewNote}>
          <Loader2Icon aria-hidden="true" className={styles.spin} /> 正在读取…
        </p>
      )
    }
    return <img alt="旧版本预览" className={styles.previewImage} src={image.src} />
  }
  if (kind === "binary") return <p className={styles.previewNote}>这种文件不能预览，可以下载后查看。</p>
  if (error) return <p className={styles.previewNote}>{error}</p>
  if (text === null) {
    return (
      <p className={styles.previewNote}>
        <Loader2Icon aria-hidden="true" className={styles.spin} /> 正在读取…
      </p>
    )
  }
  return <pre className={styles.previewText}>{text}</pre>
}

/**
 * 一个文件的版本历史：选中一条预览，可下载或恢复为它。恢复会新增一个版本，当前内容仍留在历史里，所以不再二次确认。
 * 只在以服务器为真相时出现（版本历史存在服务器上）：网页，以及连接了服务器的桌面。
 */
export function RevisionHistoryDialog({ detail, onClose }: { detail: OpenHistoryDetail; onClose: () => void }) {
  const [revisions, setRevisions] = useState<RevisionInfo[] | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const list = await listRevisions(detail.target)
      setRevisions(list.revisions)
      setSelected((current) =>
        list.revisions.some((revision) => revision.revId === current) ? current : (list.revisions[0]?.revId ?? null)
      )
      setLoadError(null)
    } catch (error) {
      setLoadError(String(error))
    }
  }, [detail.target])

  useEffect(() => {
    void load()
  }, [load])

  const current = revisions?.[0] ?? null
  const chosen = revisions?.find((revision) => revision.revId === selected) ?? null
  const canRestore = Boolean(chosen?.sha && current && chosen.revId !== current.revId && chosen.sha !== current.sha)

  /** 桌面连接服务器：经 Rust 读字节，写到选好的位置。 */
  async function downloadCopy(revision: RevisionInfo) {
    try {
      if (await saveRevisionCopy(revision)) notify.success("这个版本已保存")
    } catch (error) {
      notify.failure("下载没有完成", error)
    }
  }

  async function restore() {
    if (!chosen || !current) return
    setBusy(true)
    try {
      await restoreRevision(chosen.revId, current.sha)
      notify.success(`已恢复为 ${formatRevisionTime(chosen.createdAt)} 的版本`)
      onClose()
    } catch (error) {
      if (isStaleBase(error)) {
        notify.warning("这个文件刚在别处改过", { description: "已刷新版本列表，确认后再恢复。" })
        await load()
      } else {
        notify.failure("恢复没有完成", error)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent aria-busy={busy} className="gap-0 overflow-hidden p-0 sm:max-w-[760px]" showCloseButton={false}>
        <DialogHeader className="relative gap-1 border-b border-border px-4 py-3">
          <DialogTitle>版本历史 · {detail.title}</DialogTitle>
          <DialogDescription>同一设备 5 分钟内的连续编辑合并为一个版本；90 天后每天保留最后一个。</DialogDescription>
          <Button
            aria-label="关闭"
            className="absolute right-2 top-2"
            disabled={busy}
            onClick={onClose}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <XIcon aria-hidden="true" />
          </Button>
        </DialogHeader>
        {loadError ? (
          <p className={styles.empty}>{loadError}</p>
        ) : revisions === null ? (
          <p className={styles.empty}>
            <Loader2Icon aria-hidden="true" className={styles.spin} /> 正在读取…
          </p>
        ) : revisions.length === 0 ? (
          <p className={styles.empty}>还没有版本记录。</p>
        ) : (
          <div className={styles.layout}>
            <ol aria-label="版本列表" className={styles.list}>
              {revisions.map((revision, index) => (
                <li key={revision.revId}>
                  <button
                    aria-pressed={revision.revId === selected}
                    className={styles.listItem}
                    onClick={() => setSelected(revision.revId)}
                    type="button"
                  >
                    <span className={styles.listTime}>{formatRevisionTime(revision.createdAt)}</span>
                    <span className={styles.listMeta}>
                      {index === 0 ? "当前 · " : ""}
                      {REVISION_REASON_LABEL[revision.reason] ?? revision.reason}
                      {revision.size !== null ? ` · ${formatSize(revision.size)}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            <section aria-label="版本预览" className={styles.preview}>
              {chosen ? <RevisionPreview revision={chosen} /> : null}
            </section>
          </div>
        )}
        <div className={styles.footer}>
          {chosen?.sha && readsRevisionsViaDevice() ? (
            <Button disabled={busy} onClick={() => void downloadCopy(chosen)} size="sm" variant="outline">
              <DownloadIcon aria-hidden="true" />
              下载这个版本
            </Button>
          ) : chosen?.sha ? (
            <Button
              nativeButton={false}
              render={<a download href={revisionUrl(chosen.revId, true)} />}
              size="sm"
              variant="outline"
            >
              <DownloadIcon aria-hidden="true" />
              下载这个版本
            </Button>
          ) : null}
          <Button aria-busy={busy} disabled={!canRestore || busy} onClick={() => void restore()} size="sm">
            <HistoryIcon aria-hidden="true" />
            恢复为这个版本
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** 挂在应用根部：菜单发 `OPEN_HISTORY_EVENT`，这里弹出对话框。 */
export function RevisionHistoryHost() {
  const [detail, setDetail] = useState<OpenHistoryDetail | null>(null)
  useEffect(() => {
    const open = (event: Event) => setDetail((event as CustomEvent<OpenHistoryDetail>).detail)
    window.addEventListener(OPEN_HISTORY_EVENT, open)
    return () => window.removeEventListener(OPEN_HISTORY_EVENT, open)
  }, [])
  return detail ? <RevisionHistoryDialog detail={detail} onClose={() => setDetail(null)} /> : null
}
