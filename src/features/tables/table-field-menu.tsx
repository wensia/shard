import { useMemo } from "react";
import type { SpriteMap } from "@glideapps/glide-data-grid";
import { ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, ListIcon, PanelLeftIcon, PencilLineIcon, SearchIcon, Trash2Icon } from "@/components/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { TABLE_LIMITS, type FieldType, type TableField, type TableView } from "./model";
import { FIELD_TYPE_LABELS } from "./table-value-editor";
import type { TableFieldMenuAction } from "./table-field-actions";

export { tableFieldMenuViewChange, type TableFieldMenuAction } from "./table-field-actions";
export type TableFieldMenuAnchor = { x: number; y: number; width: number; height: number };

const ICON_PATHS: Record<FieldType, string> = {
  text: '<path d="M4 5h16M12 5v14M8 19h8"/>',
  number: '<path d="m10 3-4 18M18 3l-4 18M4 9h17M3 15h17"/>',
  date: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 11h18M7 15h2M13 15h2"/>',
  select: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m8 10 4 4 4-4"/>',
  multiSelect: '<path d="m3 6 2 2 3-3M11 7h10M3 14l2 2 3-3M11 15h10M11 20h10"/>',
  checkbox: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m7 12 3 3 7-7"/>',
};
export const tableFieldIconName = (type: FieldType) => `table-field-${type}`;
export const TABLE_FIELD_HEADER_ICONS: SpriteMap = Object.fromEntries(Object.entries(ICON_PATHS).map(([type, paths]) => [
  tableFieldIconName(type as FieldType),
  ({ bgColor }: { bgColor: string }) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${bgColor}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`,
]));

export function TableFieldMenu({ field, view, primaryFieldId, anchor, busy, onAction, onClose }: {
  field: TableField; view: TableView; primaryFieldId: string; anchor: TableFieldMenuAnchor | null; busy: boolean;
  onAction(action: TableFieldMenuAction): void; onClose(): void;
}) {
  const virtualAnchor = useMemo(() => anchor ? { getBoundingClientRect: () => DOMRect.fromRect(anchor) } : null, [anchor]);
  return <DropdownMenu open={anchor !== null} onOpenChange={open => { if (!open) onClose(); }}>
    <DropdownMenuContent anchor={virtualAnchor} aria-label={`${field.name}字段菜单`} className="click-outside-ignore" finalFocus={false}>
      <TableFieldMenuItems field={field} view={view} primaryFieldId={primaryFieldId} busy={busy} onAction={onAction} />
    </DropdownMenuContent>
  </DropdownMenu>;
}

/** Shared actions for a canvas header or a nested field-list menu. */
export function TableFieldMenuItems({ field, view, primaryFieldId, busy, onAction }: {
  field: TableField; view: TableView; primaryFieldId: string; busy: boolean;
  onAction(action: TableFieldMenuAction): void;
}) {
  const visible = view.fieldOrder.filter(id => !view.hiddenFieldIds.includes(id));
  const index = visible.indexOf(field.id);
  const sortAtLimit = view.sorts.length >= TABLE_LIMITS.sorts && !view.sorts.some(sort => sort.fieldId === field.id);
  return (
      <DropdownMenuGroup>
        <DropdownMenuLabel>{field.name} · {FIELD_TYPE_LABELS[field.type]}{field.id === primaryFieldId ? " · 主字段" : ""}</DropdownMenuLabel>
        <DropdownMenuItem disabled={busy} onClick={() => onAction("edit")}><PencilLineIcon />编辑字段</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={busy || sortAtLimit} onClick={() => onAction("sortAsc")}><ArrowUpIcon />升序排列</DropdownMenuItem>
        <DropdownMenuItem disabled={busy || sortAtLimit} onClick={() => onAction("sortDesc")}><ArrowDownIcon />降序排列</DropdownMenuItem>
        <DropdownMenuItem disabled={busy} onClick={() => onAction("filter")}><SearchIcon />筛选此字段</DropdownMenuItem>
        <DropdownMenuItem disabled={busy || field.type === "multiSelect"} onClick={() => onAction(view.groupBy === field.id ? "ungroup" : "group")}><ListIcon />{view.groupBy === field.id ? "取消此字段分组" : "按此字段分组"}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={busy || index <= 0} onClick={() => onAction("moveLeft")}><ArrowLeftIcon />向左移动</DropdownMenuItem>
        <DropdownMenuItem disabled={busy || index < 0 || index >= visible.length - 1} onClick={() => onAction("moveRight")}><ArrowRightIcon />向右移动</DropdownMenuItem>
        <DropdownMenuItem disabled={busy || field.id === primaryFieldId} onClick={() => onAction("hide")}><PanelLeftIcon />隐藏字段</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" disabled={busy || field.id === primaryFieldId} onClick={() => onAction("delete")}><Trash2Icon />删除字段</DropdownMenuItem>
      </DropdownMenuGroup>
  );
}
