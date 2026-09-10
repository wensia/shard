// Isolated development harness. It never installs an IPC mock itself and isn't a production entry.
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { Button } from "@/components/ui/button"
import { TableImportDialog, TableExportDialog } from "@/features/tables/exchange-dialog"
import type { TableFile, TableReadResult } from "@/features/tables/model"
import example from "../../tests/fixtures/tables/valid/six-types.json"
import "../index.css"
import "@fontsource/noto-sans-sc/400.css"
import "@fontsource/noto-sans-sc/500.css"

declare global { interface Window { __tableExchangeTest: { file: TableFile; created: TableReadResult[] } } }
function Harness() {
  const [dialog, setDialog] = useState<"import" | "export" | null>(null)
  return <main><Button onClick={() => setDialog("import")}>测试导入</Button><Button onClick={() => setDialog("export")}>测试导出</Button>
    {dialog === "import" && <TableImportDialog parentPath="notes" onCreated={result => { window.__tableExchangeTest.created.push(result); window.__tableExchangeTest.file = result.file }} onClose={() => setDialog(null)} />}
    {dialog === "export" && <TableExportDialog getFile={async () => window.__tableExchangeTest.file} currentViewId={window.__tableExchangeTest.file.viewOrder[0]} suggestedName="交换测试" onClose={() => setDialog(null)} />}
  </main>
}
if (import.meta.env.DEV) {
  window.__tableExchangeTest = { file: example as TableFile, created: [] }
  const root = createRoot(document.getElementById("root")!)
  root.render(<Harness />)
  import.meta.hot?.dispose(() => root.unmount())
}
