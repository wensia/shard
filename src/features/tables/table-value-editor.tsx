import { useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { GridCellKind, type GridCell, type ProvideEditorComponent, type TextCell } from "@glideapps/glide-data-grid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { DatePicker } from "@/components/ui/date-picker";
import { SelectControl } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { validateCellValue, type CellValue, type TableField } from "./model";
import { provideTableTextEditor } from "./text-cell-editor";

export const FIELD_TYPE_LABELS = { text: "文本", number: "数字", date: "日期", select: "单选", multiSelect: "多选", checkbox: "复选框" } as const;
export type TableTextCell = TextCell & { tableField: TableField; tableRecordId: string; tableValue?: CellValue };
export type TableEditorSession = { dirty: boolean; composing: boolean; commit(): boolean; cancel(): boolean };

export function displayTableValue(field: TableField, value: CellValue | undefined): string {
  if (value == null) return "";
  if (field.type === "select") return field.options.find(option => option.id === value)?.label ?? "";
  if (field.type === "multiSelect") return JSON.stringify(field.options.filter(option => (value as string[]).includes(option.id)).map(option => option.label));
  if (field.type === "checkbox") return value ? "true" : "false";
  return String(value);
}
export function parseTableEditorText(field: TableField, text: string): CellValue {
  if (field.type === "text") { validateCellValue(field, text, ""); return text; }
  if (!text) return null;
  let value: CellValue = text;
  if (field.type === "number") {
    if (!/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text.trim())) throw new Error("请输入有效数字；前导零编号应使用文本字段");
    value = Number(text);
  }
  validateCellValue(field, value, "");
  return value;
}
export function tableGridValue(cell: TableTextCell): CellValue {
  const value = cell.tableValue !== undefined ? cell.tableValue : parseTableEditorText(cell.tableField, cell.data);
  validateCellValue(cell.tableField, value, "");
  return value;
}

/** Only one cell is converted here; rectangular edits are converted in the Worker. */
export function TableValueInput({ field, value, onChange, disabled = false, label = field.name }: {
  field: TableField; value: CellValue | undefined; onChange(value: CellValue): void; disabled?: boolean; label?: string;
}) {
  if (field.type === "select" || field.type === "checkbox") return <SelectControl aria-label={label} value={value == null ? "" : String(value)} disabled={disabled}
    onValueChange={next => onChange(next === "" ? null : field.type === "checkbox" ? next === "true" : next)}
    options={[{ value: "", label: "未填写" }, ...(field.type === "checkbox" ? [{ value: "true", label: "是" }, { value: "false", label: "否" }] : ("options" in field ? field.options : []).map(option => ({ value: option.id, label: option.label })))]} />;
  if (field.type === "date") return <DatePicker aria-label={label} value={String(value ?? "")} disabled={disabled} onValueChange={next => onChange(next || null)} />;
  if (field.type === "multiSelect") return <div className="table-option-checks" role="group" aria-label={label}>
    {field.options.length === 0 && <span className="table-muted">请先在字段管理中添加选项</span>}
    {field.options.map(option => <label key={option.id}><Checkbox disabled={disabled} checked={Array.isArray(value) && value.includes(option.id)}
      onCheckedChange={checked => { const current = Array.isArray(value) ? value : []; onChange(checked ? [...current, option.id] : current.filter(id => id !== option.id)); }} />{option.label}</label>)}
  </div>;
  return <DraftTextInput field={field} value={value} onChange={onChange} disabled={disabled} label={label} />;
}
function DraftTextInput({ field, value, onChange, disabled, label }: { field: TableField; value: CellValue | undefined; onChange(value: CellValue): void; disabled: boolean; label: string }) {
  // Keep partially typed numbers in the DOM until the user confirms the form.
  return field.type === "text" ? <Textarea aria-label={label} value={String(value ?? "")} disabled={disabled} onChange={event => onChange(event.target.value)} />
    : <Input aria-label={label} value={String(value ?? "")} disabled={disabled} type="text" inputMode={field.type === "number" ? "decimal" : undefined} onChange={event => onChange(event.target.value)} />;
}

export function makeTableGridEditor(register: (session: TableEditorSession | null) => void): ProvideEditorComponent<GridCell> {
  const NativeEditor = provideTableTextEditor({ kind: GridCellKind.Text, data: "", displayData: "", allowOverlay: true }) as ComponentType<Parameters<ProvideEditorComponent<TextCell>>[0]>;
  const Editor: ProvideEditorComponent<GridCell> = props => {
    const cell = props.value as TableTextCell;
    const latest = useRef(cell);
    const initial = useRef(cell);
    const composing = useRef(false);
    const finished = useRef(false);
    const [problem, setProblem] = useState("");
    const container = useRef<HTMLDivElement>(null);
    const notify = () => register({ dirty: JSON.stringify(latest.current) !== JSON.stringify(initial.current), composing: composing.current, commit: () => finish(latest.current), cancel: () => finish(undefined) });
    function finish(next: TableTextCell | undefined, movement: readonly [-1 | 0 | 1, -1 | 0 | 1] = [0, 0]): boolean {
      if (finished.current) return true;
      if (composing.current) { setProblem("请先完成中文输入候选词，再保存或离开"); return false; }
      if (next) {
        try {
          const value = tableGridValue(next);
          // Merely opening/closing an overlay must never write its old value over a newer baseline.
          if (JSON.stringify(value) === JSON.stringify(tableGridValue(initial.current))) next = undefined;
        } catch (error) { setProblem(error instanceof Error ? error.message : String(error)); return false; }
      }
      finished.current = true; register(null); props.onFinishedEditing(next, movement); return true;
    }
    useLayoutEffect(() => {
      notify();
      if (cell.tableField.type === "date" || cell.tableField.type === "select" || cell.tableField.type === "multiSelect" || cell.tableField.type === "checkbox") container.current?.querySelector<HTMLElement>('button,[role="checkbox"],input:not([type="hidden"])')?.focus({ preventScroll: true });
      return () => register(null);
      // A mounted overlay is a single stable-ID edit session.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const change = (next: TableTextCell) => { latest.current = next; props.onChange(next); setProblem(""); notify(); };
    const selectedType = cell.tableField.type === "date" || cell.tableField.type === "select" || cell.tableField.type === "multiSelect" || cell.tableField.type === "checkbox";
    return <div ref={container} className="table-cell-overlay" onCompositionStartCapture={() => { composing.current = true; notify(); }} onCompositionEndCapture={() => { composing.current = false; notify(); }}
      onKeyDown={event => { event.stopPropagation(); if (!selectedType || composing.current || event.nativeEvent.isComposing || event.defaultPrevented) return; if (event.key === "Enter" && (event.target as HTMLElement).closest('[data-slot="select-trigger"], [data-slot="date-picker"]')) return; if (event.key === "Escape") { event.preventDefault(); finish(undefined); } else if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); finish(latest.current, event.key === "Tab" ? [event.shiftKey ? -1 : 1, 0] : [0, 1]); } }}>
      {selectedType ? <><TableValueInput field={cell.tableField} value={tableGridValue(cell)} onChange={value => change({ ...latest.current, tableValue: value, data: displayTableValue(cell.tableField, value), displayData: displayTableValue(cell.tableField, value) })} />
        <div className="table-inline-actions"><Button size="sm" variant="outline" onClick={() => change({ ...latest.current, tableValue: null, data: "", displayData: "" })}>清空</Button><Button size="sm" onClick={() => finish(latest.current)}>确定</Button></div></>
        : <NativeEditor {...props} value={cell} onChange={next => change({ ...next, tableField: cell.tableField, tableRecordId: cell.tableRecordId, tableValue: undefined })} onFinishedEditing={(next, movement) => finish(next as TableTextCell | undefined, movement)} />}
      {problem && <p role="alert" className="table-error-text">{problem}</p>}
    </div>;
  };
  return Editor;
}
