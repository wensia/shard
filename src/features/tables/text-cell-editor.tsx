import { useLayoutEffect, useRef } from "react";
import { GridCellKind, type GridCell, type ProvideEditorCallback, type ProvideEditorComponent, type TextCell } from "@glideapps/glide-data-grid";

/** Native textarea: composition keys must not reach Glide's grid navigation. */
const TextCellEditor: ProvideEditorComponent<TextCell> = ({ value, onChange, onFinishedEditing, isHighlighted }) => {
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const latest = useRef(value);
  latest.current = value;
  useLayoutEffect(() => {
    // Glide schedules grid focus on pointer activation. Focus the mounted editor
    // afterwards so reopening an edited cell cannot leave focus on the canvas.
    const frame = requestAnimationFrame(() => {
      const element = input.current;
      if (!element) return;
      element.focus({ preventScroll: true });
      element.setSelectionRange(isHighlighted ? 0 : element.value.length, element.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [isHighlighted]);
  return <textarea ref={input} className="gdg-input table-native-cell-editor" aria-label="编辑单元格" value={value.data} readOnly={value.readonly} rows={Math.min(8, value.data.split("\n").length)}
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
const TableCellEditor: ProvideEditorComponent<GridCell> = (props) => props.value.kind === GridCellKind.Text ? <TextCellEditor {...props} value={props.value} /> : null;
export const provideTableTextEditor: ProvideEditorCallback<GridCell> = (cell) => cell.kind === GridCellKind.Text ? TableCellEditor : undefined;
