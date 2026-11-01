import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react"

import { LinkIcon, Loader2Icon, PaperclipIcon, RefreshCwIcon, XIcon } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ToolbarIconButton } from "@/components/ui/toolbar-icon-button"
import { notify } from "@/lib/notify"
import {
  attachmentFileName,
  chooseKdocsAttachments,
  getKdocsAttachmentUrl,
  getKdocsStatus,
  initializeKdocs,
  isEditableKdocsError,
  KDOCS_DESKTOP_MESSAGE,
  kdocsErrorMessage,
  listKdocsRecords,
  MAX_ATTACHMENTS,
  MAX_CONTENT_LENGTH,
  normalizeKdocsTags,
  openKdocsUrl,
  saveKdocsRecord,
  type KdocsAttachment,
  type KdocsRecordPage,
  type KdocsSaveInput,
  type KdocsStatus,
} from "./api"
import { isPrivateKdocsDraft, persistKdocsDraft, readKdocsDraft, sameKdocsDraft, type KdocsDraft } from "./draft"
import styles from "./kdocs-workspace.module.css"

interface KdocsWorkspaceProps {
  onOpenLocal(): void
}

const EMPTY_PAGE: KdocsRecordPage = { records: [], hasMore: false, nextCursor: null }

function ErrorDetail({ title, message }: { title: string; message: string }) {
  return (
    <div className={styles.error} role="alert">
      <span>{title}</span>
      <details className={styles.errorDetail}>
        <summary>详情</summary>
        <p>{message}</p>
      </details>
    </div>
  )
}

function recordDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
}

function attachmentSize(size: number) {
  if (!Number.isFinite(size) || size <= 0) return ""
  return size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MiB` : `${Math.max(1, Math.round(size / 1024))} KiB`
}

export function KdocsWorkspace({ onOpenLocal }: KdocsWorkspaceProps) {
  const [initialDraft] = useState(readKdocsDraft)
  const [status, setStatus] = useState<KdocsStatus | null>(null)
  const [isStatusLoading, setIsStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [isInitializing, setIsInitializing] = useState(false)
  const [content, setContent] = useState(initialDraft.content)
  const [tags, setTags] = useState(initialDraft.tags)
  const [attachmentPaths, setAttachmentPaths] = useState(initialDraft.attachmentPaths)
  const [lastSubmission, setLastSubmission] = useState(initialDraft.submitted)
  const [isChoosingAttachments, setIsChoosingAttachments] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [draftPersistenceFailed, setDraftPersistenceFailed] = useState(false)
  const [page, setPage] = useState<KdocsRecordPage>(EMPTY_PAGE)
  const [pageIndex, setPageIndex] = useState(0)
  const [isRecordsLoading, setIsRecordsLoading] = useState(false)
  const [recordsError, setRecordsError] = useState<string | null>(null)
  const [openingAttachment, setOpeningAttachment] = useState<string | null>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const statusRequest = useRef(0)
  const recordsRequest = useRef(0)
  const mounted = useRef(true)
  const submitting = useRef(false)
  const cursorHistory = useRef<(string | null)[]>([null])
  const lastPageRequest = useRef({ index: 0, cursor: null as string | null })
  const requestId = useRef(initialDraft.requestId)
  const connection = status?.cliAvailable && status.authenticated ? status.connection : null
  const composerBusy = isSaving || isChoosingAttachments
  const privateDraft = isPrivateKdocsDraft({ content, tags, attachmentPaths, requestId: requestId.current })

  const refreshStatus = useCallback(async () => {
    const request = ++statusRequest.current
    setIsStatusLoading(true)
    setStatusError(null)
    try {
      const next = await getKdocsStatus()
      if (mounted.current && request === statusRequest.current) setStatus(next)
    } catch (error) {
      if (mounted.current && request === statusRequest.current) setStatusError(kdocsErrorMessage(error))
    } finally {
      if (mounted.current && request === statusRequest.current) setIsStatusLoading(false)
    }
  }, [])

  const loadPage = useCallback(async (index: number, cursor: string | null) => {
    const request = ++recordsRequest.current
    lastPageRequest.current = { index, cursor }
    setIsRecordsLoading(true)
    setRecordsError(null)
    try {
      const next = await listKdocsRecords(cursor)
      if (!mounted.current || request !== recordsRequest.current) return
      cursorHistory.current = cursorHistory.current.slice(0, index + 1)
      if (next.hasMore && next.nextCursor) cursorHistory.current[index + 1] = next.nextCursor
      setPage(next)
      setPageIndex(index)
      if (viewportRef.current) viewportRef.current.scrollTop = 0
    } catch (error) {
      if (mounted.current && request === recordsRequest.current) setRecordsError(kdocsErrorMessage(error))
    } finally {
      if (mounted.current && request === recordsRequest.current) setIsRecordsLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refreshStatus()
    return () => {
      mounted.current = false
      statusRequest.current += 1
      recordsRequest.current += 1
    }
  }, [refreshStatus])

  useEffect(() => {
    setDraftPersistenceFailed(!persistKdocsDraft({ content, tags, attachmentPaths, requestId: requestId.current, submitted: lastSubmission }))
  }, [content, tags, attachmentPaths, lastSubmission])

  useEffect(() => {
    if (!connection) return
    cursorHistory.current = [null]
    setPage(EMPTY_PAGE)
    setPageIndex(0)
    void loadPage(0, null)
  }, [connection?.fileId, connection?.sheetId, loadPage])

  async function initialize() {
    if (isInitializing) return
    setIsInitializing(true)
    setStatusError(null)
    try {
      const next = await initializeKdocs()
      if (mounted.current) setStatus(next)
    } catch (error) {
      if (mounted.current) setStatusError(kdocsErrorMessage(error))
    } finally {
      if (mounted.current) setIsInitializing(false)
    }
  }

  async function addAttachments() {
    if (composerBusy) return
    setIsChoosingAttachments(true)
    try {
      const selected = await chooseKdocsAttachments()
      if (!mounted.current || selected.length === 0) return
      const next = [...new Set([...attachmentPaths, ...selected])]
      if (next.length > MAX_ATTACHMENTS) {
        notify.warning(`最多添加 ${MAX_ATTACHMENTS} 个附件`)
        return
      }
      setAttachmentPaths(next)
      setSaveError(null)
    } catch (error) {
      notify.failure("附件选择失败", error)
    } finally {
      if (mounted.current) setIsChoosingAttachments(false)
    }
  }

  async function submit(recovery?: KdocsDraft) {
    if (submitting.current || isChoosingAttachments || !connection) return
    const current = { content, tags, attachmentPaths, requestId: requestId.current }
    const draft = recovery ?? current
    if (isPrivateKdocsDraft(draft)) return
    if (!draft.content.trim() && draft.attachmentPaths.length === 0) return
    if (!recovery && lastSubmission && !sameKdocsDraft(lastSubmission, current)) {
      setSaveError("请先重试上次保存，确认结果后再保存改动。")
      return
    }
    const input: KdocsSaveInput = { content: draft.content.trim(), tags: normalizeKdocsTags(draft.tags), attachmentPaths: draft.attachmentPaths, requestId: draft.requestId }
    const keepCurrentDraft = !sameKdocsDraft(draft, current)
    if (!persistKdocsDraft({ ...current, submitted: draft })) {
      setDraftPersistenceFailed(true)
      setSaveError("无法保留草稿，请先释放本地存储空间再重试。")
      return
    }
    setDraftPersistenceFailed(false)
    submitting.current = true
    setIsSaving(true)
    setSaveError(null)
    setLastSubmission(draft)
    try {
      await saveKdocsRecord(input)
      if (!mounted.current) return
      requestId.current = crypto.randomUUID()
      setLastSubmission(null)
      if (keepCurrentDraft) {
        notify.success("上次记录已保存，当前草稿已保留")
      } else {
        setContent("")
        setTags("")
        setAttachmentPaths([])
        notify.success("记录已保存")
      }
      void loadPage(0, null)
      requestAnimationFrame(() => editorRef.current?.focus({ preventScroll: true }))
    } catch (error) {
      if (mounted.current) {
        if (isEditableKdocsError(error)) setLastSubmission(null)
        setSaveError(kdocsErrorMessage(error))
      }
    } finally {
      submitting.current = false
      if (mounted.current) setIsSaving(false)
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void submit()
  }

  function handleShortcut(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return
    event.preventDefault()
    void submit()
  }

  async function openAttachment(attachment: KdocsAttachment) {
    if (openingAttachment) return
    setOpeningAttachment(attachment.objectId)
    try {
      const url = await getKdocsAttachmentUrl(attachment.objectId)
      await openKdocsUrl(url)
    } catch (error) {
      notify.failure("附件打开失败", error)
    } finally {
      if (mounted.current) setOpeningAttachment(null)
    }
  }

  async function openSource() {
    if (!connection) return
    try {
      await openKdocsUrl(connection.url)
    } catch (error) {
      notify.failure("多维表格打开失败", error)
    }
  }

  function openLocal() {
    // A stored public draft can be restored after the connection is repaired.
    if (!connection && !privateDraft) {
      if (!persistKdocsDraft({ content, tags, attachmentPaths, requestId: requestId.current, submitted: lastSubmission })) {
        setDraftPersistenceFailed(true)
        notify.error("草稿未能保留，请先复制内容")
        return
      }
      onOpenLocal()
      return
    }
    if (content || tags || attachmentPaths.length > 0 || lastSubmission) {
      notify.info(privateDraft ? "请先复制私密草稿，清空后再打开本地资料" : "请先保存云端草稿，再打开本地资料")
      return
    }
    onOpenLocal()
  }

  const pageCount = cursorHistory.current.length
  const firstVisiblePage = Math.max(0, Math.min(pageIndex - 1, pageCount - 3))
  const visiblePages = Array.from({ length: Math.min(3, pageCount) }, (_, offset) => firstVisiblePage + offset)

  return (
    <main className={styles.workspace} data-kdocs-workspace data-density="compact">
      <header className={styles.titlebar} data-tauri-drag-region="true" data-focus-region="kdocs-navigation" aria-label="多维表格导航">
        <h1 className={styles.title} data-tauri-drag-region="true">Shard <span>多维表格</span></h1>
        <div className={styles.titleActions}>
          {connection && <Button variant="outline" size="sm" onClick={() => void openSource()}><LinkIcon />金山文档</Button>}
          <Button variant="outline" size="sm" disabled={isSaving || isInitializing} onClick={openLocal}>本地资料</Button>
        </div>
      </header>

      {!connection ? (
        <section className={styles.setup} data-focus-region="kdocs-connection" aria-labelledby="kdocs-connect-title" aria-busy={isStatusLoading || isInitializing}>
          <div className={styles.setupContent}>
            <h2 id="kdocs-connect-title">连接金山文档</h2>
            {isStatusLoading ? <p className={styles.muted} role="status">正在检查连接…</p> : status ? (
              <dl className={styles.connectionStatus}>
                <div><dt>金山文档工具</dt><dd>{status.cliAvailable ? "已安装" : "未安装"}</dd></div>
                <div><dt>登录状态</dt><dd>{status.authenticated ? "已登录" : "未登录"}</dd></div>
              </dl>
            ) : null}
            {!isStatusLoading && status?.cliAvailable && !status.authenticated && (
              <p className={styles.loginHint}>在终端运行 <code>kdocs-cli auth login</code> 后重新检查。</p>
            )}
            {!isStatusLoading && status && !status.cliAvailable && (
              <p className={styles.loginHint}>在终端运行 <code>bash ~/.codex/skills/kdocs/scripts/setup.sh</code> 后重新检查。</p>
            )}
            {statusError && (statusError === KDOCS_DESKTOP_MESSAGE ? <p className={styles.muted}>{statusError}</p> : <ErrorDetail title="连接未完成" message={statusError} />)}
            {draftPersistenceFailed && (content || tags || attachmentPaths.length > 0 || lastSubmission) && <p className={styles.privacyHint} role="alert">草稿未能保留，关闭前请先复制内容。</p>}
            <div className={styles.setupActions}>
              <Button variant="primary" disabled={!status?.cliAvailable || !status.authenticated || isStatusLoading || isInitializing} onClick={() => void initialize()}>
                {isInitializing ? "正在创建…" : "创建 Shard 多维表格"}
              </Button>
              <Button variant="outline" disabled={isStatusLoading || isInitializing} onClick={() => void refreshStatus()}>重新检查</Button>
            </div>
          </div>
        </section>
      ) : (
        <div className={styles.connectedBody}>
          <form className={styles.composer} onSubmit={handleSubmit} onKeyDown={handleShortcut} aria-label="快速录入" aria-busy={composerBusy}>
            <div className={styles.editorRegion} data-focus-region="kdocs-editor">
              <label className={styles.sectionTitle} htmlFor="kdocs-content">快速录入</label>
              <Textarea id="kdocs-content" ref={editorRef} className={styles.editor} data-focus-editor autoFocus placeholder="记下一条新记录…" value={content} maxLength={MAX_CONTENT_LENGTH} disabled={composerBusy} onChange={event => { setContent(event.target.value); setSaveError(null) }} />
            </div>
            <div className={styles.captureActions} data-focus-region="kdocs-capture-actions" aria-label="录入选项">
              <div className={styles.tagField}>
                <label htmlFor="kdocs-tags">标签</label>
                <Input id="kdocs-tags" className={styles.tagInput} placeholder="用空格分隔" value={tags} maxLength={2048} disabled={composerBusy} onChange={event => { setTags(event.target.value); setSaveError(null) }} />
              </div>
              <Button variant="outline" title="最多 10 个，单个 20 MiB，合计 50 MiB" disabled={composerBusy || attachmentPaths.length >= MAX_ATTACHMENTS} onClick={() => void addAttachments()}><PaperclipIcon />添加附件</Button>
              <div className={styles.saveGroup}>
                <span className={styles.shortcut} title="F6 切换区域，Ctrl 或 Command 加 Enter 保存">⌘ / Ctrl + Enter</span>
                <Button variant="primary" type="submit" disabled={composerBusy || privateDraft || (!content.trim() && attachmentPaths.length === 0)}>{isSaving ? "正在保存…" : "保存"}</Button>
              </div>
            </div>
            {attachmentPaths.length > 0 && (
              <ul className={styles.pendingAttachments} aria-label="待上传附件">
                {attachmentPaths.map(path => <li key={path} className={styles.pendingAttachment} title={path}>
                  <PaperclipIcon className={styles.smallIcon} aria-hidden="true" />
                  <span className={styles.fileName}>{attachmentFileName(path)}</span>
                  <ToolbarIconButton label={`移除 ${attachmentFileName(path)}`} variant="outline" disabled={composerBusy} onClick={() => { setAttachmentPaths(current => current.filter(value => value !== path)); setSaveError(null) }}><XIcon /></ToolbarIconButton>
                </li>)}
              </ul>
            )}
            {saveError && <ErrorDetail title={draftPersistenceFailed ? "草稿未能保留" : "保存未确认，草稿已保留"} message={saveError} />}
            {draftPersistenceFailed && !privateDraft && !saveError && <p className={styles.privacyHint} role="alert">草稿未能保留，关闭前请先复制内容。</p>}
            {privateDraft && <p className={styles.privacyHint} role="alert">密匣内容请使用本地资料，草稿仅保留在当前窗口。</p>}
            {lastSubmission && <div className={styles.saveRecovery}>
              {!saveError && <span className={styles.muted}>上次保存待确认</span>}
              <Button variant="outline" size="sm" disabled={composerBusy} onClick={() => void submit(lastSubmission)}>重试上次保存</Button>
            </div>}
          </form>

          <section className={styles.records} aria-labelledby="kdocs-records-title">
            <div className={styles.recordsToolbar} data-focus-region="kdocs-record-actions">
              <h2 id="kdocs-records-title" className={styles.sectionTitle}>记录</h2>
              <Button variant="outline" size="sm" disabled={isRecordsLoading || isSaving} onClick={() => void loadPage(0, null)}><RefreshCwIcon />刷新</Button>
            </div>
            {recordsError && <div className={styles.recordsError}><ErrorDetail title="记录读取失败" message={recordsError} /><Button variant="outline" size="sm" disabled={isRecordsLoading} onClick={() => void loadPage(lastPageRequest.current.index, lastPageRequest.current.cursor)}>重试</Button></div>}
            <div ref={viewportRef} className={styles.tableViewport} data-kdocs-table-viewport data-focus-region="kdocs-records" tabIndex={0} aria-label="多维表格记录" aria-busy={isRecordsLoading}>
              <table className={styles.table}>
                <colgroup><col className={styles.contentColumn} /><col className={styles.tagsColumn} /><col className={styles.attachmentsColumn} /><col className={styles.dateColumn} /></colgroup>
                <thead><tr><th scope="col">内容</th><th scope="col">标签</th><th scope="col">附件</th><th scope="col">创建时间</th></tr></thead>
                <tbody>
                  {isRecordsLoading && Array.from({ length: 3 }, (_, index) => <tr key={`loading-${index}`} data-slot="table-row" aria-hidden="true"><td><span className={styles.skeleton} /></td><td><span className={styles.skeleton} /></td><td><span className={styles.skeleton} /></td><td><span className={styles.skeleton} /></td></tr>)}
                  {!isRecordsLoading && page.records.map(record => <tr key={record.id} data-slot="table-row">
                    <td><div className={styles.recordContent}>{record.content || "仅附件"}</div></td>
                    <td><div className={styles.recordTags}>{record.tags.map(tag => <Badge key={tag} variant="secondary">{tag}</Badge>)}</div></td>
                    <td><div className={styles.recordAttachments}>{record.attachments.map(attachment => <Button key={attachment.objectId} className={styles.attachmentButton} variant="outline" size="sm" title={`${attachment.name}${attachment.size ? ` · ${attachmentSize(attachment.size)}` : ""}`} disabled={openingAttachment !== null} aria-busy={openingAttachment === attachment.objectId} onClick={() => void openAttachment(attachment)}>{openingAttachment === attachment.objectId ? <Loader2Icon className={styles.spinner} /> : <PaperclipIcon />}<span className={styles.fileName}>{attachment.name}</span></Button>)}</div></td>
                    <td><time className={styles.recordDate} dateTime={record.createdAt} title={record.createdAt}>{recordDate(record.createdAt)}</time></td>
                  </tr>)}
                </tbody>
              </table>
              {isRecordsLoading && <p className="sr-only" role="status">正在读取记录…</p>}
              {!isRecordsLoading && !recordsError && page.records.length === 0 && <p className={styles.tableState}>还没有记录，从上方开始录入。</p>}
            </div>
            <footer className={styles.pagination} data-focus-region="kdocs-pagination" aria-label="记录分页">
              <span className={styles.pageCount}>本页 {page.records.length} 条</span>
              <nav className={styles.pageButtons} aria-label="记录页码">
                {visiblePages.map(index => <Button key={index} variant={index === pageIndex ? "primary" : "outline"} size="sm" className={styles.pageButton} aria-label={`第 ${index + 1} 页`} aria-current={index === pageIndex ? "page" : undefined} disabled={isRecordsLoading || isSaving || index === pageIndex} onClick={() => void loadPage(index, cursorHistory.current[index])}>{index + 1}</Button>)}
              </nav>
            </footer>
          </section>
        </div>
      )}
    </main>
  )
}
