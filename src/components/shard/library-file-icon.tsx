import {
  FileIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FolderIcon,
  GitBranchIcon,
  ImageIcon,
  PanelsTopLeftIcon,
  TableIcon,
  WorkflowIcon,
  type ShardIcon,
} from "@/components/icons"
import type { LibraryTreeEntryKind } from "@/types"

// 列表、卡片标题和预览后备图共享同一套格式标识。
const FILE_ICONS = {
  directory: FolderIcon,
  markdown: FileTextIcon,
  csv: FileSpreadsheetIcon,
  mindmap: GitBranchIcon,
  flowchart: WorkflowIcon,
  canvas: PanelsTopLeftIcon,
  table: TableIcon,
  image: ImageIcon,
  file: FileIcon,
} satisfies Record<LibraryTreeEntryKind, ShardIcon>

export function LibraryFileIcon({
  className,
  kind,
}: {
  className?: string
  kind: LibraryTreeEntryKind
}) {
  const Icon = FILE_ICONS[kind]
  return <Icon aria-hidden="true" className={className} data-file-kind={kind} />
}
