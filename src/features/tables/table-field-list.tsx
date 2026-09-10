import { useRef, useState } from "react";
import { LockKeyholeIcon, MoreHorizontalIcon, PlusIcon, SearchIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { TABLE_LIMITS, type TableContent, type TableField, type TableView } from "./model";
import { TableFieldMenuItems, type TableFieldMenuAction } from "./table-field-menu";
import { FIELD_TYPE_LABELS } from "./table-value-editor";
import "./table-field-list.css";

export type TableFieldListProps = {
  metadata: Omit<TableContent, "records">;
  view: TableView;
  busy: boolean;
  onEdit(fieldId: string, anchor: HTMLElement): void;
  onAdd(anchor: HTMLElement): void;
  onToggleVisibility(fieldId: string): void;
  onMenuAction(fieldId: string, action: TableFieldMenuAction, anchor: DOMRect): void;
};

/** The same six silhouettes used by the canvas column headers. */
export function TableFieldTypeIcon({ type, className = "" }: { type: TableField["type"]; className?: string }) {
  return <svg aria-hidden="true" className={`table-field-type-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
    {type === "text" && <path d="M4 5h16M12 5v14M8 19h8" />}
    {type === "number" && <path d="m10 3-4 18M18 3l-4 18M4 9h17M3 15h17" />}
    {type === "date" && <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4M17 3v4M3 11h18M7 15h2M13 15h2" /></>}
    {type === "select" && <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m8 10 4 4 4-4" /></>}
    {type === "multiSelect" && <path d="m3 6 2 2 3-3M11 7h10M3 14l2 2 3-3M11 15h10M11 20h10" />}
    {type === "checkbox" && <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="m7 12 3 3 7-7" /></>}
  </svg>;
}

export function TableFieldList({ metadata, view, busy, onEdit, onAdd, onToggleVisibility, onMenuAction }: TableFieldListProps) {
  const [query, setQuery] = useState("");
  const search = query.trim().toLocaleLowerCase();
  const fieldIds = view.fieldOrder.filter(id => metadata.fields[id].name.toLocaleLowerCase().includes(search));
  return <TooltipProvider><section className="table-field-list" aria-label="字段配置" aria-busy={busy}>
    <div className="table-field-list-search"><SearchIcon /><Input type="search" aria-label="搜索字段" placeholder="搜索字段" value={query} onChange={event => setQuery(event.target.value)} /></div>
    <div className="table-field-list-scroll" role="list" aria-label="字段列表">
      {fieldIds.map(id => {
        const field = metadata.fields[id];
        const primary = id === metadata.primaryFieldId;
        const visible = !view.hiddenFieldIds.includes(id);
        return <div key={id} role="listitem" className="table-field-list-row" data-hidden={!visible}>
          <Checkbox aria-label={`显示${field.name}字段`} checked={visible} disabled={busy || primary} onCheckedChange={() => onToggleVisibility(id)} />
          <Button className="table-field-list-edit" variant="ghost" size="sm" disabled={busy} aria-label={`编辑${field.name}字段`} title={`${field.name} · ${FIELD_TYPE_LABELS[field.type]}`} onClick={event => onEdit(id, event.currentTarget)}><TableFieldTypeIcon type={field.type} /><span>{field.name}</span></Button>
          {primary && <span className="table-field-list-lock" role="img" aria-label="主字段，不可隐藏"><LockKeyholeIcon /></span>}
          <TableFieldListMenu field={field} view={view} primaryFieldId={metadata.primaryFieldId} busy={busy} onAction={onMenuAction} />
        </div>;
      })}
      {!fieldIds.length && <p className="table-field-list-empty" role="status">未找到匹配字段</p>}
    </div>
    <footer className="table-field-list-footer"><Button variant="outline" size="sm" disabled={busy || metadata.fieldOrder.length >= TABLE_LIMITS.fields} onClick={event => onAdd(event.currentTarget)}><PlusIcon />新增字段</Button></footer>
  </section></TooltipProvider>;
}

function TableFieldListMenu({ field, view, primaryFieldId, busy, onAction }: {
  field: TableField; view: TableView; primaryFieldId: string; busy: boolean;
  onAction: TableFieldListProps["onMenuAction"];
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  return <DropdownMenu open={menuOpen} onOpenChange={open => { setMenuOpen(open); setTooltipOpen(false); }}>
    <Tooltip open={tooltipOpen && !menuOpen} onOpenChange={(open, details) => {
      // Returning from the menu must not insert a tooltip into the Escape stack.
      if (open && details.reason === "trigger-focus") return;
      setTooltipOpen(open && !menuOpen);
    }}><TooltipTrigger render={<DropdownMenuTrigger render={<Button ref={trigger} variant="ghost" size="icon-sm" className="table-field-list-more" disabled={busy} aria-label={`${field.name}字段更多操作`}><MoreHorizontalIcon /></Button>} />} /><TooltipContent>{field.name}字段更多操作</TooltipContent></Tooltip>
    <DropdownMenuContent side="right" aria-label={`${field.name}字段菜单`} className="click-outside-ignore" finalFocus={() => trigger.current?.isConnected ? trigger.current : false}>
      <TableFieldMenuItems field={field} view={view} primaryFieldId={primaryFieldId} busy={busy} onAction={action => { if (trigger.current) onAction(field.id, action, trigger.current.getBoundingClientRect()); }} />
    </DropdownMenuContent>
  </DropdownMenu>;
}
