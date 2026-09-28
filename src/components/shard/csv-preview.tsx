import { useEffect, useState } from "react"

import { getApiErrorMessage, openCsvFile, readCsvFile } from "@/lib/api"
import { isNonUtf8CsvEncoding, type CsvDocument } from "@/lib/csv"
import { parseCsvBytesInWorker } from "@/lib/csv-worker"
import { notify } from "@/lib/notify"
import { openDatasetEditor } from "@/features/datasets/open-dataset"

import styles from "./csv-preview.module.css"

interface CsvPreviewProps {
  maxRows: number
  path: string
}

export function CsvInlineLink({ label, path }: { label: string; path: string }) {
  async function open() {
    try {
      await openCsvFile(path)
    } catch (error) {
      notify.failure("CSV 文件打开失败", error)
    }
  }

  return (
    <button className={styles.inlineLink} onClick={() => void open()} type="button">
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

  useEffect(() => {
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
  }, [path])

  async function openWithDefaultProgram() {
    if (isOpening) return
    setIsOpening(true)
    try {
      await openCsvFile(path)
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
                    <td key={cellIndex}>{row[cellIndex] ?? ""}</td>
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
          {isOpening ? "正在打开…" : "用默认程序打开"}
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
