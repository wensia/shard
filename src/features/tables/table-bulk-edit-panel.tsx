import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectControl } from "@/components/ui/select";
import { validateCellValue, type CellValue, type TableContent } from "./model";
import type { TablePanelHandle } from "./table-config-panel";
import { FIELD_TYPE_LABELS, parseTableEditorText, TableValueInput } from "./table-value-editor";

type Props = {
  metadata: Omit<TableContent, "records">;
  /** The owner freezes these IDs and the onApply target for one mounted session. */
  recordIds: readonly string[];
  busy: boolean;
  onApply(fieldId: string, value: CellValue): Promise<boolean>;
  onClose(): void;
  onDirtyChange(): void;
};

export const TableBulkEditPanel = forwardRef<TablePanelHandle, Props>(function TableBulkEditPanel({ metadata, recordIds, busy, onApply, onClose, onDirtyChange }, ref) {
  const recordCount = useRef(recordIds.length).current;
  const [fieldId, setFieldId] = useState("");
  const [value, setValue] = useState<CellValue>(null);
  const [touched, setTouched] = useState(false);
  const draft = useRef<{ fieldId: string; value: CellValue; dirty: boolean }>({ fieldId: "", value: null, dirty: false });
  const composing = useRef(false);
  const pending = useRef<Promise<boolean> | null>(null);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState("");
  const [applied, setApplied] = useState(false);
  const field = metadata.fields[fieldId];
  const locked = busy || working || recordCount === 0;

  function change(next: CellValue) {
    draft.current = { ...draft.current, value: next, dirty: true };
    setValue(next); setTouched(true); setProblem(""); setApplied(false); onDirtyChange();
  }

  async function applyDraft(): Promise<boolean> {
    setWorking(true); setProblem(""); setApplied(false);
    try {
      const selected = metadata.fields[draft.current.fieldId];
      if (!selected) throw new Error("字段已不存在，请重新选择要修改的字段");
      let next = draft.current.value;
      if (typeof next === "string" && (selected.type === "number" || selected.type === "date")) next = parseTableEditorText(selected, next);
      validateCellValue(selected, next, `/fields/${selected.id}`);
      if (!await onApply(selected.id, next)) {
        setProblem("批量修改未应用，已保留输入内容，请检查工作区提示后重试");
        return false;
      }
      draft.current = { fieldId: selected.id, value: next, dirty: false };
      setValue(next); setTouched(false); setApplied(true); onDirtyChange();
      return true;
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      return false;
    } finally { setWorking(false); }
  }

  async function commit(): Promise<boolean> {
    if (pending.current) return pending.current;
    if (composing.current) {
      setProblem("请先完成中文输入候选词，再应用或离开");
      return false;
    }
    if (!draft.current.dirty) return true;
    const operation = applyDraft();
    pending.current = operation;
    try { return await operation; }
    finally { pending.current = null; }
  }

  async function selectField(next: string) {
    if (next === draft.current.fieldId || pending.current) return;
    if (!await commit()) return;
    draft.current = { fieldId: next, value: null, dirty: false };
    setFieldId(next); setValue(null); setTouched(false); setProblem(""); setApplied(false);
  }

  useImperativeHandle(ref, () => ({ commit, isDirty: () => draft.current.dirty || composing.current }));

  return <aside className="table-record-panel" aria-label="批量修改字段" aria-busy={busy || working}>
    <header className="table-panel-header"><strong>批量修改字段</strong><Button type="button" variant="outline" size="sm" disabled={busy || working} onClick={() => { void commit().then(ok => { if (ok) onClose(); }); }}>返回表格</Button></header>
    <form className="table-record-form" onSubmit={event => { event.preventDefault(); void commit(); }}
      onCompositionStartCapture={() => { composing.current = true; onDirtyChange(); }}
      onCompositionEndCapture={() => { composing.current = false; onDirtyChange(); }}>
      <div className="table-panel-scroll">
        <p className="table-muted">将修改选中的 {recordCount} 条记录。其他字段保持不变。</p>
        <label className="table-form-field">修改字段<SelectControl aria-label="修改字段" value={fieldId} disabled={locked} onValueChange={next => { void selectField(next); }}
          options={[{ value: "", label: "选择要修改的字段", disabled: true }, ...metadata.fieldOrder.map(id => ({ value: id, label: `${metadata.fields[id].name} · ${FIELD_TYPE_LABELS[metadata.fields[id].type]}` }))]} /></label>
        {field && <div className="table-form-field">
          <div className="table-field-label"><label>统一设置为</label><div className="table-inline-actions">
            {field.type === "multiSelect" && <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => change([])}>设为空选项</Button>}
            <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => change(null)}>清空</Button>
          </div></div>
          <TableValueInput key={field.id} field={field} value={value} disabled={locked} label={`批量设置${field.name}`} onChange={change} />
          {!touched && !applied ? <span className="table-muted">输入新值或点击清空后才会修改记录。</span>
            : value === null ? <span className="table-muted">{applied ? "已清空该字段" : "将清空所选记录的该字段"}</span>
            : field.type === "multiSelect" && Array.isArray(value) && value.length === 0 ? <span className="table-muted">已填写：无选项</span> : null}
        </div>}
        {problem && <p role="alert" className="table-error-text">{problem}</p>}
        {applied && <p role="status" className="table-muted">已更新 {recordCount} 条记录</p>}
      </div>
      <footer className="table-panel-footer"><Button type="submit" disabled={locked || !touched || !field}>{working ? "应用中…" : `应用到 ${recordCount} 条记录`}</Button></footer>
    </form>
  </aside>;
});
