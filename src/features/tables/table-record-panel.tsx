import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { TableFieldTypeIcon } from "./table-field-list";
import { Button } from "@/components/ui/button";
import { validateCellValue, type CellValue, type TableContent, type TableRecord } from "./model";
import type { TableMutation } from "./mutations";
import type { TablePanelHandle } from "./table-config-panel";
import { parseTableEditorText, TableValueInput } from "./table-value-editor";

type Props = { record: TableRecord; metadata: Omit<TableContent, "records">; busy: boolean; onMutate(operations: TableMutation[]): Promise<boolean>; onClose(): void; onDirtyChange(): void };
export const TableRecordPanel = forwardRef<TablePanelHandle, Props>(function TableRecordPanel({ record, metadata, busy, onMutate, onClose, onDirtyChange }, ref) {
  const [values, setValues] = useState(record.values);
  const draft = useRef(values);
  const touched = useRef(new Set<string>());
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => { formRef.current?.querySelector<HTMLElement>("textarea, input:not([type=hidden])")?.focus({ preventScroll: true }); }, []);
  useEffect(() => { if (!touched.current.size) { draft.current = record.values; setValues(record.values); } }, [record]);
  const change = (fieldId: string, value: CellValue) => {
    touched.current.add(fieldId); draft.current = { ...draft.current, [fieldId]: value }; setValues(draft.current); setProblem(""); onDirtyChange();
  };
  async function commit() {
    if (!touched.current.size) return true;
    setWorking(true); setProblem("");
    try {
      const cells = [...touched.current].map(fieldId => {
        const field = metadata.fields[fieldId]; let value = draft.current[fieldId];
        if (typeof value === "string" && (field.type === "number" || field.type === "date")) value = parseTableEditorText(field, value);
        validateCellValue(field, value, `/records/${record.id}/values/${fieldId}`);
        return { recordId: record.id, fieldId, value };
      });
      if (!await onMutate([{ type: "setCells", cells }])) return false;
      touched.current.clear(); onDirtyChange(); return true;
    } catch (error) { setProblem(error instanceof Error ? error.message : String(error)); return false; }
    finally { setWorking(false); }
  }
  useImperativeHandle(ref, () => ({ commit, isDirty: () => touched.current.size > 0 }));
  return <aside className="table-record-panel table-record-details" aria-label="记录详情" aria-busy={busy || working}>
    <header className="table-panel-header"><strong>记录详情</strong><Button variant="outline" size="sm" disabled={busy || working} onClick={() => { void commit().then(ok => { if (ok) onClose(); }); }}>返回表格</Button></header>
    <form ref={formRef} className="table-record-form" onSubmit={event => { event.preventDefault(); void commit(); }}>
      <div className="table-panel-scroll"><h2 className="table-record-title">{typeof values[metadata.primaryFieldId] === "string" && String(values[metadata.primaryFieldId]).trim() ? String(values[metadata.primaryFieldId]).split("\n")[0] : "未命名记录"}</h2><div className="table-record-section-label">详情</div>{metadata.fieldOrder.map(fieldId => {
        const field = metadata.fields[fieldId];
        return <div className="table-record-property" key={fieldId}><label className="table-record-property-label"><TableFieldTypeIcon type={field.type} />{field.name}</label><div className="table-record-property-value">
          <TableValueInput field={field} value={values[fieldId]} disabled={busy || working} onChange={value => change(fieldId, value)} />
          {values[fieldId] === null || values[fieldId] === undefined ? <span className="table-muted">未填写</span> : field.type === "multiSelect" && Array.isArray(values[fieldId]) && !values[fieldId].length ? <span className="table-muted">已填写：无选项</span> : null}
          <Button className="table-record-clear" variant="ghost" size="sm" disabled={busy || working || values[fieldId] == null} onClick={() => change(fieldId, null)}>清空</Button></div>
        </div>;
      })}{problem && <p role="alert" className="table-error-text">{problem}</p>}</div>
      <footer className="table-panel-footer"><Button type="submit" disabled={busy || working}>{working ? "应用中…" : "应用记录"}</Button></footer>
    </form>
  </aside>;
});
