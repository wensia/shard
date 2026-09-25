import { useState } from "react"
import { createRoot } from "react-dom/client"
import { Button } from "@/components/ui/button"
import { DatePicker } from "@/components/ui/date-picker"
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { SelectControl } from "@/components/ui/select"
import { TimePicker } from "@/components/ui/time-picker"
import "../index.css"
import "@fontsource/noto-sans-sc/400.css"
import "@fontsource/noto-sans-sc/500.css"
import "@fontsource/noto-sans-sc/600.css"

function Harness() {
  const [selected, setSelected] = useState("")
  const [date, setDate] = useState("")
  const [time, setTime] = useState("")
  const [outerKeys, setOuterKeys] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const options = [ { value: "", label: "未填写" }, { value: "field-name", label: "名称（主字段）" }, { value: "field-disabled", label: "不可用字段", disabled: true },
    ...Array.from({ length: 30 }, (_, index) => ({ value: `field-${index}`, label: `字段 ${index + 1}${index === 29 ? "：一段很长的中文字段名称，用于验证窄窗口完整阅读与横向边界" : ""}` })) ]
  return <main className="p-4 flex flex-col gap-4" onKeyDown={event => { if (["Enter", "Escape"].includes(event.key)) setOuterKeys(current => [...current, event.key]) }}>
    <h1>共享表单控件</h1>
    <div className="flex gap-2 min-w-0"><Input aria-label="参考输入框" /><SelectControl aria-label="字段" name="field" value={selected} onValueChange={setSelected} options={options} /></div>
    <DatePicker aria-label="日期" value={date} onValueChange={setDate} />
    <TimePicker aria-label="时间" value={time} onValueChange={setTime} />
    <SelectControl aria-label="禁用字段" value="field-name" onValueChange={setSelected} options={options} disabled />
    <DatePicker aria-label="禁用日期" value="2024-02-29" onValueChange={setDate} disabled />
    <TimePicker aria-label="禁用时间" value="09:30" onValueChange={setTime} disabled />
    <output aria-label="选择结果">{selected || "empty"}</output>
    <output aria-label="日期结果">{date || "empty"}</output>
    <output aria-label="时间结果">{time || "empty"}</output>
    <output aria-label="外层快捷键">{outerKeys.join(",") || "none"}</output>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" />}>打开表单</DialogTrigger>
      <DialogContent><DialogTitle>控件弹窗</DialogTitle>
        <SelectControl aria-label="弹窗字段" value={selected} onValueChange={setSelected} options={options} />
        <DatePicker aria-label="弹窗日期" value={date} onValueChange={setDate} />
        <TimePicker aria-label="弹窗时间" value={time} onValueChange={setTime} />
      </DialogContent>
    </Dialog>
  </main>
}
if (import.meta.env.DEV) createRoot(document.getElementById("root")!).render(<Harness />)
