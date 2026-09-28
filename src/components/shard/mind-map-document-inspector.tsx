import { SelectControl } from "@/components/ui/select"
import { TabLabel } from "@/components/ui/tabs"
import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, XIcon } from "@/components/icons"
import { getApiErrorMessage, listDiagramDocuments } from "@/lib/api"
import { addMindMapChild, addMindMapSibling, deleteMindMapNode, getMindMapChildren, getMindMapRows, toggleMindMapNodeCollapsed, updateMindMapNodeText, type MindMapChangeMeta } from "@/lib/mind-map-tree"
import type { DiagramDocumentSummary, Fragment, ShardDocumentLink, ShardMapFile, ShardMapNode } from "@/types"
import styles from "./mind-map-workspace.module.css"

const tones = { default: "默认", accent: "陶土", success: "青绿", warning: "琥珀" } as const

interface Props {
  file: ShardMapFile
  selectedNodeIds: string[]
  fragments: Fragment[]
  onChange: (file: ShardMapFile, meta?: MindMapChangeMeta) => void
  onSelectNode: (id: string) => void
  onClose: () => void
  onOpenLink?: (link: ShardDocumentLink) => Promise<void> | void
}

export function MindMapDocumentInspector({ file, selectedNodeIds, fragments, onChange, onSelectNode, onClose, onOpenLink }: Props) {
  const [tab, setTab] = useState<"properties" | "outline">("properties")
  const [documents, setDocuments] = useState<DiagramDocumentSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [pickerOpen, setPickerOpen] = useState(false)
  const selected = selectedNodeIds.length === 1 ? file.nodes[selectedNodeIds[0]] : null
  const rows = useMemo(() => getMindMapRows(file), [file])

  useEffect(() => {
    let active = true
    setLoading(true)
    void listDiagramDocuments().then(result => {
      if (active) { setDocuments(result); setError(null) }
    }, reason => { if (active) setError(getApiErrorMessage(reason)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [file.id, pickerOpen])

  const sources = useMemo(() => [
    ...documents.filter(document => document.id !== file.id).map(document => ({
      key: `${document.kind}:${document.id}`, title: document.title,
      kind: document.kind === "mindmap" ? "思维导图" : "流程图",
      link: { targetType: document.kind === "mindmap" ? "map" : "flow", targetId: document.id } as Omit<Extract<ShardDocumentLink, { targetType: "map" | "flow" }>, "id">,
    })),
    ...fragments.filter(fragment => !fragment.lockbox && !fragment.archived).map(fragment => ({
      key: `fragment:${fragment.id}`, title: fragment.content.replace(/^#+\s*/, "").split("\n")[0] || "未命名文档",
      kind: fragment.kind === "note" ? "文档" : "片段",
      link: { targetType: "fragment", targetId: fragment.id } as const,
    })),
  ], [documents, file.id, fragments])
  const filteredSources = sources.filter(source => source.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))

  function updateNode(patch: Partial<ShardMapNode>, mergeKey?: string) {
    if (!selected) return
    const stamp = new Date().toISOString()
    onChange({ ...file, updatedAt: stamp, nodes: { ...file.nodes, [selected.id]: { ...selected, ...patch, updatedAt: stamp } } }, mergeKey ? { mergeKey } : undefined)
  }

  function addTopic(child: boolean) {
    if (!selected) return
    const result = child ? addMindMapChild(file, selected.id) : addMindMapSibling(file, selected.id)
    onChange(result.file)
    onSelectNode(result.nodeId)
  }

  function linkTitle(link: ShardDocumentLink) {
    if (link.targetType === "markdownPath") return link.path.split("/").pop() ?? link.path
    return sources.find(source => source.link.targetType === link.targetType && source.link.targetId === link.targetId)?.title ?? "文档暂不可用"
  }

  return <aside aria-label="思维导图检查器" className={styles.inspector} data-focus-region="mind-map-panel" data-mind-map-inspector data-mind-map-side-panel data-density="compact">
    <header className={styles.inspectorHeader} data-mind-map-panel-header><strong>主题属性</strong><Button variant="ghost" size="icon-sm" aria-label="关闭检查器" onClick={onClose}><XIcon /></Button></header>
    <div className={`shard-tabs ${styles.inspectorTabs}`} role="tablist" aria-label="导图检查器视图">
      {(["properties", "outline"] as const).map((value, index) => <button className="shard-tab" key={value} type="button" role="tab" id={`map-${value}-tab`} aria-controls={`map-${value}-panel`}
        aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={event => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
          event.preventDefault(); setTab(index === 0 ? "outline" : "properties")
          const parent = event.currentTarget.parentElement
          ;(parent?.children[index === 0 ? 1 : 0] as HTMLElement | undefined)?.focus()
        }}><TabLabel>{value === "properties" ? "属性" : "主题导航"}</TabLabel></button>)}
    </div>
    <div className={styles.inspectorBody} role="tabpanel" id={`map-${tab}-panel`} aria-labelledby={`map-${tab}-tab`}>
      {tab === "outline" ? <div className={styles.outline} aria-label="导图主题导航">{rows.map(({ node, depth }) => <div key={node.id} className={styles.outlineRow} style={{ paddingInlineStart: `calc(${Math.min(depth, 8)} * var(--space-3))` }}>
        <button className={styles.outlineToggle} type="button" aria-label={`${node.collapsed ? "展开" : "折叠"} ${node.text || "未命名"}`} disabled={!getMindMapChildren(file, node.id).length || node.id === file.rootId}
          onClick={() => onChange(toggleMindMapNodeCollapsed(file, node.id))}>{node.collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}</button>
        <button type="button" className={styles.outlineLabel} aria-pressed={selectedNodeIds.includes(node.id)} onClick={() => onSelectNode(node.id)} title={node.text}>{node.text || "未命名"}</button>
      </div>)}</div> : selected ? <>
        <div className={styles.topicActions}>
          <Button size="sm" variant="outline" onClick={() => addTopic(true)} title="Tab">子主题</Button>
          <Button size="sm" variant="outline" onClick={() => addTopic(false)} title="Enter">同级主题</Button>
          <Button size="sm" variant="outline" disabled={selected.id === file.rootId || !getMindMapChildren(file, selected.id).length}
            onClick={() => onChange(toggleMindMapNodeCollapsed(file, selected.id))}>{selected.collapsed ? "展开" : "折叠"}</Button>
        </div>
        <label className={styles.field}>主题文字<Textarea aria-label="主题文字" rows={3} value={selected.text} onChange={event => onChange(updateMindMapNodeText(file, selected.id, event.target.value), { mergeKey: `text:${selected.id}` })} /></label>
        <fieldset className={styles.tones}><legend>强调色</legend><div>{Object.entries(tones).map(([tone, title]) => <button className={styles.toneButton} key={tone} data-tone={tone} aria-label={`主题颜色：${title}`} aria-pressed={(selected.style?.tone ?? "default") === tone}
          onClick={() => updateNode({ style: { ...selected.style, tone: tone as keyof typeof tones } })}><span>{(selected.style?.tone ?? "default") === tone && <CheckIcon />}</span>{title}</button>)}</div></fieldset>
        <label className={styles.field}>主题宽度<SelectControl aria-label="主题宽度" value={String(selected.width ?? "auto")} onValueChange={value => updateNode({ width: value === "auto" ? undefined : Number(value) })}
          options={[{ value: "auto", label: "自动" }, { value: "160", label: "紧凑 · 160" }, { value: "240", label: "标准 · 240" }, { value: "320", label: "宽 · 320" }, { value: "420", label: "加宽 · 420" },
            ...(selected.width && ![160, 240, 320, 420].includes(selected.width) ? [{ value: String(selected.width), label: `自定义 · ${selected.width}` }] : [])]} /></label>
        <section className={styles.references} aria-label="关联文档"><div className={styles.sectionHeader}><strong>关联文档</strong><Button size="sm" variant="ghost" onClick={() => setPickerOpen(!pickerOpen)}>{pickerOpen ? "收起" : "添加引用"}</Button></div>
          {(selected.links ?? []).map(link => <div key={link.id} className={styles.referenceRow}><button type="button" className={styles.documentLink} disabled={!onOpenLink} onClick={() => void onOpenLink?.(link)} title={linkTitle(link)}>{linkTitle(link)}</button><Button size="icon-sm" variant="ghost" aria-label={`移除引用 ${linkTitle(link)}`} onClick={() => updateNode({ links: selected.links?.filter(item => item.id !== link.id) })}><XIcon /></Button></div>)}
          {!selected.links?.length && !pickerOpen && <p className={styles.muted}>尚未关联文档</p>}
          {pickerOpen && <div className={styles.referencePicker} aria-busy={loading}><Input aria-label="搜索关联文档" placeholder="搜索文档、思维导图或流程图" value={query} onChange={event => setQuery(event.target.value)} />
            {loading && <p className={styles.muted}>正在载入文档</p>}{error && <p role="alert">{error}</p>}
            <div className={styles.referenceResults}>{filteredSources.map(source => <button className={styles.referenceResult} key={source.key} type="button" onClick={() => {
              const existing = selected.links ?? []
              if (!existing.some(link => link.targetType !== "markdownPath" && link.targetType === source.link.targetType && link.targetId === source.link.targetId)) updateNode({ links: [...existing, { id: crypto.randomUUID(), ...source.link }] })
              setPickerOpen(false); setQuery("")
            }}><span>{source.title}</span><small>{source.kind}</small></button>)}</div>
            {!loading && !filteredSources.length && <p className={styles.muted}>没有匹配的文档</p>}
          </div>}
        </section>
        <div className={styles.deleteTopic}><Button variant="ghost" size="sm" disabled={selected.id === file.rootId} onClick={() => {
          const result = deleteMindMapNode(file, selected.id); onChange(result.file); onSelectNode(result.focusNodeId)
        }}>删除主题及子主题</Button></div>
      </> : <p className={styles.muted}>{selectedNodeIds.length > 1 ? `已选中 ${selectedNodeIds.length} 个主题。选择一个主题以编辑属性。` : "选择一个主题以编辑属性"}</p>}
    </div>
  </aside>
}
