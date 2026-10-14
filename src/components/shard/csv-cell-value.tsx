import { useState } from "react"

import { FragmentImageAttachment } from "@/components/shard/fragment-content"
import { parseCellImageRefs } from "@/lib/cell-image-refs"

import styles from "./csv-cell-value.module.css"

/**
 * 只读表格（笔记里的 CSV 嵌入、数据表块）的单元格：写的是图片引用就显示缩略图，
 * 点开看原图；任何一张取不到就退回原文，写错的路径一眼能看出来。
 */
export function CsvCellValue({ value }: { value: string }) {
  const refs = parseCellImageRefs(value)
  const [failedValue, setFailedValue] = useState<string | null>(null)
  if (!refs || failedValue === value) return <>{value}</>
  return (
    <span className={styles.images} data-csv-image-cell="true">
      {refs.map((ref) => (
        <FragmentImageAttachment
          alt={ref.split("/").pop()?.replace(/\.[^.]+$/u, "") ?? ""}
          key={ref}
          onLoadError={() => setFailedValue(value)}
          path={ref}
          previewable
          wrapped={false}
        />
      ))}
    </span>
  )
}
