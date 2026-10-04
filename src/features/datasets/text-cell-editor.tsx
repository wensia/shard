import { useLayoutEffect, useRef } from "react";
import "./text-cell-editor.css";
import { GridCellKind, type GridCell, type ProvideEditorCallback, type ProvideEditorComponent, type TextCell } from "@glideapps/glide-data-grid";

/** Native textarea: composition keys must not reach Glide's grid navigation. */
type TextCellEditorProps = Parameters<ProvideEditorComponent<TextCell>>[0] & { takeTyped: () => string };

const TextCellEditor = ({ value, onChange, onFinishedEditing, isHighlighted, takeTyped }: TextCellEditorProps) => {
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const latest = useRef(value);
  latest.current = value;
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    // 打字激活时 Glide 已把首键写进 value.data；编辑框挂上之前用户接着打的字由宿主暂存，挂上这一刻补进来。
    // 只能在提交阶段取：渲染可能被丢弃或延后，提前取会清空暂存，后续按键就会另起一次编辑。
    const typed = takeTyped();
    if (typed) {
      const next = { ...value, data: value.data + typed, displayData: value.data + typed };
      latest.current = next;
      element.value = next.data;
      onChange(next);
    }
    // 挂载即取焦点，紧随其后的按键才不会落回网格。
    element.focus({ preventScroll: true });
    const start = isHighlighted && !typed ? 0 : element.value.length;
    element.setSelectionRange(start, element.value.length);
    // 指针激活时 Glide 随后会把焦点还给画布；下一帧只夺回焦点，不改用户已有的光标与输入。
    const frame = requestAnimationFrame(() => { if (document.activeElement !== element) element.focus({ preventScroll: true }); });
    return () => cancelAnimationFrame(frame);
    // 只在挂载时执行：onChange 每次渲染都是新函数。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <textarea ref={input} className="gdg-input dataset-cell-editor" aria-label="编辑单元格" data-focus-editor value={value.data} readOnly={value.readonly} rows={Math.min(8, value.data.split("\n").length)}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={() => { composing.current = false; }}
    onChange={(event) => { const next = { ...value, data: event.target.value, displayData: event.target.value }; latest.current = next; onChange(next); }}
    onKeyDown={(event) => {
      if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) { event.stopPropagation(); return; }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onFinishedEditing(undefined, [0, 0]); }
      else if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault(); event.stopPropagation(); onFinishedEditing(latest.current, event.key === "Tab" ? [event.shiftKey ? -1 : 1, 0] : [0, 1]);
      }
    }} />;
};
/** `takeTyped` 取走并清空宿主在编辑框挂出前暂存的按键。 */
export function createTextCellEditorProvider(takeTyped: () => string): ProvideEditorCallback<GridCell> {
  const GridTextCellEditor: ProvideEditorComponent<GridCell> = (props) => props.value.kind === GridCellKind.Text ? <TextCellEditor {...props} value={props.value} takeTyped={takeTyped} /> : null;
  return (cell) => cell.kind === GridCellKind.Text ? GridTextCellEditor : undefined;
}
