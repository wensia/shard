import { XIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import styles from "./mind-map-shortcuts.module.css"

interface Props {
  view: "map" | "outline"
  onClose: () => void
}

interface Shortcut {
  action: string
  keys: string
  detail?: string
}

function ShortcutGroup({ title, shortcuts }: { title: string; shortcuts: Shortcut[] }) {
  return (
    <section className={styles.group} aria-label={title}>
      <h3>{title}</h3>
      <dl className={styles.list}>
        {shortcuts.map(({ action, keys, detail }) => (
          <div className={styles.row} key={action}>
            <dt>{action}{detail && <small>{detail}</small>}</dt>
            <dd><kbd className={styles.key}>{keys}</kbd></dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

export function MindMapShortcuts({ view, onClose }: Props) {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  const command = isMac ? "⌘" : "Ctrl"
  const option = isMac ? "⌥" : "Alt"
  const topicCreation: Shortcut[] = [
    { action: "新建同级主题", keys: "Enter", detail: "根主题下会新建子主题" },
    { action: "新建子主题", keys: "Tab" },
    { action: "提升一级", keys: "Shift + Tab", detail: "根主题及其直接子主题不能再提升" },
  ]
  const outlineStructure: Shortcut[] = [
    { action: "新建同级主题", keys: "Enter", detail: "标题内进入第一个主题；没有主题时新建" },
    { action: "缩进当前主题", keys: "Tab", detail: "移入前一个同级主题；没有前一个同级时保持不变" },
    { action: "提升一级", keys: "Shift + Tab", detail: "标题及顶层主题不能再提升" },
  ]
  const textEditing: Shortcut[] = [
    ...topicCreation,
    { action: "文字内换行", keys: "Shift + Enter" },
    { action: "结束文字编辑", keys: `${command} + Enter / Esc`, detail: "保留文字和主题选择" },
    { action: "删除空主题及其子主题", keys: view === "map" ? "Backspace / Delete" : "Backspace", detail: "根主题保留" },
  ]

  return (
    <aside className={styles.panel} aria-label="思维导图快捷键" data-mind-map-shortcuts data-mind-map-side-panel data-density="compact">
      <header className={styles.header} data-mind-map-panel-header>
        <h2>快捷键</h2>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="关闭快捷键" onClick={onClose}><XIcon /></Button>
      </header>
      <div className={styles.body}>
        <p className={styles.context}>{view === "map" ? "思维导图视图" : "大纲视图"}</p>
        {view === "map" ? (
          <>
            <ShortcutGroup title="选中主题时" shortcuts={[
              ...topicCreation,
              { action: "在前面新建同级主题", keys: "Shift + Enter", detail: "根主题下会新建子主题" },
              { action: "插入父主题", keys: `${command} + Enter`, detail: "根主题不适用" },
              { action: "编辑主题文字", keys: "F2 / Space", detail: "也可以双击主题；直接输入字符会替换原文字" },
              { action: "删除主题及子主题", keys: "Backspace / Delete", detail: "支持多选，根主题保留" },
              { action: "仅删除主题，保留子主题", keys: `${command} + Backspace / Delete`, detail: "子主题提升一级" },
              { action: "取消主题选择", keys: "Esc" },
            ]} />
            <ShortcutGroup title="编辑文字时" shortcuts={textEditing} />
            <ShortcutGroup title="浏览与整理" shortcuts={[
              { action: "选择父主题 / 子主题", keys: "← / →", detail: "向右先展开折叠的子主题" },
              { action: "选择上一个 / 下一个同级主题", keys: "↑ / ↓" },
              { action: "上移 / 下移同级主题", keys: `${option} + ↑ / ↓` },
              { action: "展开 / 折叠子主题", keys: `${command} + /`, detail: "选中有子主题的非根主题时" },
              { action: "适合画布", keys: `${command} + 0` },
            ]} />
            <ShortcutGroup title="鼠标与触控板" shortcuts={[
              { action: "添加或取消选择", keys: `${command} + 单击` },
              { action: "连续多选", keys: "Shift + 单击" },
              { action: "框选主题", keys: "拖动空白处" },
              { action: "平移画布", keys: "Space + 拖动", detail: "先单击空白处取消选择；也可使用滚轮或双指滑动" },
              { action: "缩放画布", keys: `${command} + 滚轮`, detail: "也可使用触控板捏合" },
            ]} />
            <p className={styles.note}>拖动主题或主题旁的拖动柄，按落点提示调整层级与顺序。多选时一起移动，根主题不参与移动。</p>
          </>
        ) : (
          <>
            <ShortcutGroup title="输入主题时" shortcuts={[
              ...outlineStructure,
              { action: "进入主题描述", keys: "Shift + Enter", detail: "补充说明独立保存在当前主题下" },
              { action: "主题文字内换行", keys: `${option} + Enter` },
              { action: "结束文字编辑", keys: `${command} + Enter / Esc` },
              { action: "移除空主题", keys: "Backspace", detail: "有描述、引用或子主题时保留内容并尝试提升一级" },
              { action: "进入上一个 / 下一个主题", keys: "↑ / ↓", detail: "光标位于文字开头 / 末尾，且没有文字选区时" },
              { action: "上移 / 下移同级主题", keys: `${command} + Shift + ↑ / ↓`, detail: `也支持 ${option} + ↑ / ↓` },
            ]} />
            <ShortcutGroup title="输入描述时" shortcuts={[
              { action: "描述内换行", keys: "Enter" },
              { action: "返回主题文字", keys: `Shift + Enter / ${command} + Enter / Esc` },
              { action: "切换到下一个控件", keys: "Tab", detail: "不改变主题层级" },
            ]} />
            <ShortcutGroup title="浏览与整理" shortcuts={[
              { action: "展开 / 折叠子主题", keys: `${command} + .`, detail: `当前标题不折叠；也支持 ${option} + .` },
              { action: "删除主题及子主题", keys: `${command} + Shift + Backspace`, detail: "主题文字输入或选中时使用，根标题保留" },
              { action: "聚焦当前主题", keys: `${command} + ]`, detail: "也可以单击主题圆点" },
              { action: "返回上一级大纲", keys: `${command} + [`, detail: "也可以使用顶部面包屑" },
              { action: "继续编辑主题", keys: "F2 / Space", detail: "结束输入后使用" },
              { action: "删除选中主题及子主题", keys: "Backspace / Delete", detail: "结束输入后使用，根标题保留" },
            ]} />
            <p className={styles.note}>点击主题直接输入。单击圆点聚焦子树，拖动圆点调整层级与顺序；折叠主题的圆点带有外圈，悬停或键盘聚焦时显示左侧展开按钮和主题菜单。</p>
          </>
        )}
        <ShortcutGroup title="通用" shortcuts={[
          { action: "保存", keys: `${command} + S` },
          { action: "撤销", keys: `${command} + Z` },
          { action: "重做", keys: `${command} + Shift + Z` },
          { action: "全选 / 复制 / 粘贴文字", keys: `${command} + A / C / V`, detail: "文字输入框内使用原生文字选区" },
        ]} />
        <p className={styles.note}>中文输入法选字期间，Enter 和方向键用于确认候选词。工具栏、属性和快捷键面板中的 Tab 用于切换控件。</p>
      </div>
    </aside>
  )
}
