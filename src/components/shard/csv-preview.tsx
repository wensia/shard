import { useEffect, useRef, useState } from "react"

import { downloadVaultCsv, getApiErrorMessage, openCsvFile, readCsvFile } from "@/lib/api"
import { isWebRuntime } from "@/lib/transport"
import { isNonUtf8CsvEncoding, type CsvDocument } from "@/lib/csv"
import { parseCsvBytesInWorker } from "@/lib/csv-worker"
import { notify } from "@/lib/notify"
import { openDatasetEditor } from "@/features/datasets/open-dataset"
import { CsvCellValue } from "@/components/shard/csv-cell-value"

import styles from "./csv-preview.module.css"

interface CsvPreviewProps {
  maxRows: number
  path: string
}

export function CsvInlineLink({ label, path }: { label: string; path: string }) {
  return (
    <button className={styles.inlineLink} onClick={() => openDatasetEditor(path)} type="button">
      {label}
    </button>
  )
}

type LoadState =
  | { state: "loading" }
  | { message: string; state: "error" }
  | { document: CsvDocument; state: "ready" }

export function CsvPreview({ maxRows, path }: CsvPreviewProps) {
  const [loadState, setLoadState] = useState<LoadState>({ state: "loading" })
  const [isOpening, setIsOpening] = useState(false)
  const sectionRef = useRef<HTMLElement>(null)
  // 长文档里可能嵌着很多张表：滚到附近才读文件、解析。
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined")

  useEffect(() => {
    const target = sectionRef.current
    if (visible || !target) return
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      setVisible(true)
    }, { rootMargin: "400px 0px" })
    observer.observe(target)
    return () => observer.disconnect()
  }, [visible])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    setLoadState({ state: "loading" })
    const reload = () => {
      void readCsvFile(path)
        .then((bytes) => parseCsvBytesInWorker(Uint8Array.from(bytes)))
        .then((document) => {
          if (!cancelled) setLoadState({ document, state: "ready" })
        })
        .catch((error) => {
          if (!cancelled) {
            setLoadState({ message: getApiErrorMessage(error), state: "error" })
          }
        })
    }
    reload()
    const changed = (event: Event) => { if ((event as CustomEvent<{ path: string }>).detail.path === path) reload() }
    window.addEventListener("shard:dataset-changed", changed)
    return () => {
      cancelled = true
      window.removeEventListener("shard:dataset-changed", changed)
    }
  }, [path, visible])

  async function openWithDefaultProgram() {
    if (isOpening) return
    setIsOpening(true)
    try {
      if (isWebRuntime()) await downloadVaultCsv(path)
      else await openCsvFile(path)
    } catch (error) {
      notify.failure("CSV 文件打开失败", error)
    } finally {
      setIsOpening(false)
    }
  }

  if (loadState.state !== "ready") {
    return (
      <section
        aria-busy={loadState.state === "loading"}
        aria-label={`CSV 预览：${path}`}
        className={styles.preview}
        data-csv-path={path}
        ref={sectionRef}
      >
        <div className={styles.status} role={loadState.state === "error" ? "alert" : "status"}>
          {loadState.state === "loading"
            ? "正在读取 CSV…"
            : `无法预览 CSV：${loadState.message}`}
        </div>
      </section>
    )
  }

  const { document } = loadState
  const [header = [], ...rows] = document.records
  const visibleRows = rows.slice(0, maxRows)
  const columnCount = Math.max(header.length, ...visibleRows.map((row) => row.length), 0)

  return (
    <section
      aria-busy={false}
      aria-label={`CSV 预览：${path}`}
      className={styles.preview}
      data-csv-path={path}
      data-visible-rows={visibleRows.length}
      ref={sectionRef}
    >
      {document.records.length === 0 ? (
        <div className={styles.status}>CSV 文件为空</div>
      ) : (
        <div
          aria-label="CSV 表格，可横向和纵向滚动"
          className={styles.scroll}
          role="region"
          tabIndex={0}
        >
          <table className={styles.table}>
            <thead>
              <tr>
                {Array.from({ length: columnCount }, (_, index) => (
                  <th key={index} scope="col">{header[index] ?? ""}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {Array.from({ length: columnCount }, (_, cellIndex) => (
                    <td key={cellIndex}><CsvCellValue value={row[cellIndex] ?? ""} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <footer className={styles.footer}>
        <span>共 {rows.length} 行</span>
        <span aria-hidden="true">·</span>
        <button className={styles.openButton} onClick={() => openDatasetEditor(path)} type="button">编辑</button>
        <button
          className={styles.openButton}
          disabled={isOpening}
          onClick={() => void openWithDefaultProgram()}
          type="button"
        >
          {isOpening ? "正在打开…" : isWebRuntime() ? "下载 CSV" : "用默认程序打开"}
        </button>
        {isNonUtf8CsvEncoding(document.encoding) ? (
          <span className={styles.encoding}>
            {document.encoding.toUpperCase()} · 建议另存为 UTF-8
          </span>
        ) : null}
      </footer>
    </section>
  )
}
