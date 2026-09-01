/**
 * 图标注册表：应用内唯一的图标导入面（design.md「落地架构」）。
 * 应用代码一律 `import { XIcon } from "@/components/icons"`，
 * 禁止直连 lucide-react——verify-tokens 的 iconImport 规则守着。
 *
 * 描边与尺寸不在这里控制：描边走 frontend-rules.css 的
 * `svg.lucide { stroke-width: var(--shard-icon-stroke) }` 全局规则，
 * 尺寸走容器的 --shard-icon-size-* token。这里只负责：
 * 默认 aria-hidden（图标默认装饰性，配文字标签的调用点可显式覆盖）、
 * 语义别名、以及未来换库时的唯一切面。
 */
import { forwardRef } from "react"
import {
  ArchiveIcon as LArchive,
  ArchiveRestoreIcon as LArchiveRestore,
  ArrowBigUpIcon as LArrowBigUp,
  ArrowDownIcon as LArrowDown,
  ArrowLeftIcon as LArrowLeft,
  ArrowRightIcon as LArrowRight,
  ArrowUpIcon as LArrowUp,
  BoldIcon as LBold,
  BookOpenIcon as LBookOpen,
  CalendarDaysIcon as LCalendarDays,
  CheckIcon as LCheck,
  ChevronDownIcon as LChevronDown,
  ChevronLeftIcon as LChevronLeft,
  ChevronRightIcon as LChevronRight,
  CircleAlertIcon as LCircleAlert,
  CircleCheckIcon as LCircleCheck,
  CopyIcon as LCopy,
  CornerUpLeftIcon as LCornerUpLeft,
  DownloadIcon as LDownload,
  FilePlus2Icon as LFilePlus2,
  FileSpreadsheetIcon as LFileSpreadsheet,
  FileTextIcon as LFileText,
  FolderIcon as LFolder,
  FolderOpenIcon as LFolderOpen,
  FolderPlusIcon as LFolderPlus,
  GitBranchIcon as LGitBranch,
  Grid2X2Icon as LGrid2X2,
  GripVerticalIcon as LGripVertical,
  HashIcon as LHash,
  HelpCircleIcon as LHelpCircle,
  HighlighterIcon as LHighlighter,
  HistoryIcon as LHistory,
  ImageIcon as LImage,
  InboxIcon as LInbox,
  InfoIcon as LInfo,
  KeyboardIcon as LKeyboard,
  LinkIcon as LLink,
  ListIcon as LList,
  ListOrderedIcon as LListOrdered,
  ListTodoIcon as LListTodo,
  ListTreeIcon as LListTree,
  Loader2Icon as LLoader2,
  LockKeyholeIcon as LLockKeyhole,
  Maximize2Icon as LMaximize2,
  MoreHorizontalIcon as LMoreHorizontal,
  MoveIcon as LMove,
  PaletteIcon as LPalette,
  PanelLeftIcon as LPanelLeft,
  PaperclipIcon as LPaperclip,
  PencilLineIcon as LPencilLine,
  PinIcon as LPin,
  PinOffIcon as LPinOff,
  PlusIcon as LPlus,
  RefreshCwIcon as LRefreshCw,
  RouteIcon as LRoute,
  SaveIcon as LSave,
  SearchIcon as LSearch,
  SendHorizontalIcon as LSendHorizontal,
  SeparatorHorizontalIcon as LSeparatorHorizontal,
  SettingsIcon as LSettings,
  Share2Icon as LShare2,
  SparklesIcon as LSparkles,
  TableIcon as LTable,
  TagIcon as LTag,
  TextCursorInputIcon as LTextCursorInput,
  Trash2Icon as LTrash2,
  TriangleAlertIcon as LTriangleAlert,
  UnderlineIcon as LUnderline,
  XIcon as LX,
  type LucideIcon,
  type LucideProps,
} from "lucide-react"

/** 应用内图标组件的统一类型（= LucideIcon，命名收口便于将来换库）。 */
export type ShardIcon = LucideIcon
export type { LucideIcon }

function withIconDefaults(Icon: LucideIcon): LucideIcon {
  const Wrapped = forwardRef<SVGSVGElement, Omit<LucideProps, "ref">>(
    (props, ref) => <Icon aria-hidden="true" ref={ref} {...props} />
  )
  Wrapped.displayName = Icon.displayName ?? "ShardIcon"
  return Wrapped as LucideIcon
}

export const ArchiveIcon = /*#__PURE__*/ withIconDefaults(LArchive)
export const ArchiveRestoreIcon = /*#__PURE__*/ withIconDefaults(LArchiveRestore)
export const ArrowBigUpIcon = /*#__PURE__*/ withIconDefaults(LArrowBigUp)
export const ArrowDownIcon = /*#__PURE__*/ withIconDefaults(LArrowDown)
export const ArrowLeftIcon = /*#__PURE__*/ withIconDefaults(LArrowLeft)
export const ArrowRightIcon = /*#__PURE__*/ withIconDefaults(LArrowRight)
export const ArrowUpIcon = /*#__PURE__*/ withIconDefaults(LArrowUp)
export const BoldIcon = /*#__PURE__*/ withIconDefaults(LBold)
export const BookOpenIcon = /*#__PURE__*/ withIconDefaults(LBookOpen)
export const CalendarDaysIcon = /*#__PURE__*/ withIconDefaults(LCalendarDays)
export const CheckIcon = /*#__PURE__*/ withIconDefaults(LCheck)
export const ChevronDownIcon = /*#__PURE__*/ withIconDefaults(LChevronDown)
export const ChevronLeftIcon = /*#__PURE__*/ withIconDefaults(LChevronLeft)
export const ChevronRightIcon = /*#__PURE__*/ withIconDefaults(LChevronRight)
export const CircleAlertIcon = /*#__PURE__*/ withIconDefaults(LCircleAlert)
export const CircleCheckIcon = /*#__PURE__*/ withIconDefaults(LCircleCheck)
export const CopyIcon = /*#__PURE__*/ withIconDefaults(LCopy)
export const CornerUpLeftIcon = /*#__PURE__*/ withIconDefaults(LCornerUpLeft)
export const DownloadIcon = /*#__PURE__*/ withIconDefaults(LDownload)
export const FilePlus2Icon = /*#__PURE__*/ withIconDefaults(LFilePlus2)
export const FileSpreadsheetIcon = /*#__PURE__*/ withIconDefaults(LFileSpreadsheet)
export const FileTextIcon = /*#__PURE__*/ withIconDefaults(LFileText)
export const FolderIcon = /*#__PURE__*/ withIconDefaults(LFolder)
export const FolderOpenIcon = /*#__PURE__*/ withIconDefaults(LFolderOpen)
export const FolderPlusIcon = /*#__PURE__*/ withIconDefaults(LFolderPlus)
export const GitBranchIcon = /*#__PURE__*/ withIconDefaults(LGitBranch)
export const Grid2X2Icon = /*#__PURE__*/ withIconDefaults(LGrid2X2)
export const GripVerticalIcon = /*#__PURE__*/ withIconDefaults(LGripVertical)
export const HashIcon = /*#__PURE__*/ withIconDefaults(LHash)
export const HelpCircleIcon = /*#__PURE__*/ withIconDefaults(LHelpCircle)
export const HighlighterIcon = /*#__PURE__*/ withIconDefaults(LHighlighter)
export const HistoryIcon = /*#__PURE__*/ withIconDefaults(LHistory)
export const ImageIcon = /*#__PURE__*/ withIconDefaults(LImage)
export const InboxIcon = /*#__PURE__*/ withIconDefaults(LInbox)
export const InfoIcon = /*#__PURE__*/ withIconDefaults(LInfo)
export const KeyboardIcon = /*#__PURE__*/ withIconDefaults(LKeyboard)
export const LinkIcon = /*#__PURE__*/ withIconDefaults(LLink)
export const ListIcon = /*#__PURE__*/ withIconDefaults(LList)
export const ListOrderedIcon = /*#__PURE__*/ withIconDefaults(LListOrdered)
export const ListTodoIcon = /*#__PURE__*/ withIconDefaults(LListTodo)
export const ListTreeIcon = /*#__PURE__*/ withIconDefaults(LListTree)
export const Loader2Icon = /*#__PURE__*/ withIconDefaults(LLoader2)
export const LockKeyholeIcon = /*#__PURE__*/ withIconDefaults(LLockKeyhole)
export const Maximize2Icon = /*#__PURE__*/ withIconDefaults(LMaximize2)
export const MoreHorizontalIcon = /*#__PURE__*/ withIconDefaults(LMoreHorizontal)
export const MoveIcon = /*#__PURE__*/ withIconDefaults(LMove)
export const PaletteIcon = /*#__PURE__*/ withIconDefaults(LPalette)
export const PanelLeftIcon = /*#__PURE__*/ withIconDefaults(LPanelLeft)
export const PaperclipIcon = /*#__PURE__*/ withIconDefaults(LPaperclip)
export const PencilLineIcon = /*#__PURE__*/ withIconDefaults(LPencilLine)
export const PinIcon = /*#__PURE__*/ withIconDefaults(LPin)
export const PinOffIcon = /*#__PURE__*/ withIconDefaults(LPinOff)
export const PlusIcon = /*#__PURE__*/ withIconDefaults(LPlus)
export const RefreshCwIcon = /*#__PURE__*/ withIconDefaults(LRefreshCw)
export const RouteIcon = /*#__PURE__*/ withIconDefaults(LRoute)
export const SaveIcon = /*#__PURE__*/ withIconDefaults(LSave)
export const SearchIcon = /*#__PURE__*/ withIconDefaults(LSearch)
export const SendHorizontalIcon = /*#__PURE__*/ withIconDefaults(LSendHorizontal)
export const SeparatorHorizontalIcon = /*#__PURE__*/ withIconDefaults(LSeparatorHorizontal)
export const SettingsIcon = /*#__PURE__*/ withIconDefaults(LSettings)
export const Share2Icon = /*#__PURE__*/ withIconDefaults(LShare2)
export const SparklesIcon = /*#__PURE__*/ withIconDefaults(LSparkles)
export const TableIcon = /*#__PURE__*/ withIconDefaults(LTable)
export const TagIcon = /*#__PURE__*/ withIconDefaults(LTag)
export const TextCursorInputIcon = /*#__PURE__*/ withIconDefaults(LTextCursorInput)
export const Trash2Icon = /*#__PURE__*/ withIconDefaults(LTrash2)
export const TriangleAlertIcon = /*#__PURE__*/ withIconDefaults(LTriangleAlert)
export const UnderlineIcon = /*#__PURE__*/ withIconDefaults(LUnderline)
export const XIcon = /*#__PURE__*/ withIconDefaults(LX)

// 签名图标（design.md）：手绘、单色、与库图标同管道。
export { ShardZenIcon } from "./signature/zen"
