/**
 * 标签建议与命令菜单共用一个浮层。两个 Suggestion 插件的 render 钩子是命令式的，
 * 这个 host 把它们收敛成一份 React 可订阅的状态：谁后打开谁占用浮层，
 * 键盘选中态只存在这里，避免两套菜单各画一个弹层、各记一套下标。
 */
export interface SuggestionMenuItem {
  /** React key，同一次打开内唯一。 */
  key: string
  label: string
  /** 候选右侧徽标：标签是「使用 / 新建 / 保存到密匣」，命令是 hint。 */
  badge: string
}

export type SuggestionMenuSource = "tag" | "slash" | "wikilink"

export interface SuggestionMenuOpenOptions<Item extends SuggestionMenuItem> {
  source: SuggestionMenuSource
  ariaLabel: string
  items: Item[]
  /** 光标锚点矩形；取不到时保持上一次的位置。 */
  rect: DOMRect | null
  onSelect: (item: Item) => void
}

export interface SuggestionMenuState {
  ariaLabel: string
  items: SuggestionMenuItem[]
  activeIndex: number
  anchor: { bottom: number; left: number; top: number }
}

type Listener = (state: SuggestionMenuState | null) => void

const NAVIGATION_KEYS = new Set(["ArrowDown", "ArrowUp", "Enter", "Tab"])

export class SuggestionMenuHost {
  private state: SuggestionMenuState | null = null
  private source: SuggestionMenuSource | null = null
  private select: ((index: number) => void) | null = null

  constructor(private readonly listener: Listener) {}

  open<Item extends SuggestionMenuItem>(options: SuggestionMenuOpenOptions<Item>) {
    this.source = options.source
    this.apply(options, 0)
  }

  update<Item extends SuggestionMenuItem>(options: SuggestionMenuOpenOptions<Item>) {
    if (this.source !== options.source) return
    // 候选变了就回到第一项：过滤后的列表与旧下标没有对应关系。
    const keepIndex =
      this.state && sameKeys(this.state.items, options.items) ? this.state.activeIndex : 0
    this.apply(options, keepIndex)
  }

  close(source: SuggestionMenuSource) {
    if (this.source !== source) return
    this.source = null
    this.select = null
    this.state = null
    this.listener(null)
  }

  /** 供浮层里的指针点击调用。 */
  selectIndex(index: number) {
    this.select?.(index)
  }

  setActiveIndex(index: number) {
    if (!this.state || index === this.state.activeIndex) return
    this.state = { ...this.state, activeIndex: index }
    this.listener(this.state)
  }

  /** 返回 true 表示按键已被浮层消化，不再交给编辑器。 */
  handleKeyDown(source: SuggestionMenuSource, event: KeyboardEvent) {
    const state = this.state
    if (this.source !== source || !state || state.items.length === 0) return false
    // 带修饰键的组合是宿主键位，不是菜单导航：Cmd/Ctrl+Enter 必须落到提交上，
    // 否则菜单开着时永远提交不了（建议插件的 handleKeyDown 排在宿主 keymap 之前）。
    if (event.metaKey || event.ctrlKey || event.altKey) return false
    if (!NAVIGATION_KEYS.has(event.key)) return false

    if (event.key === "Enter" || event.key === "Tab") {
      this.select?.(state.activeIndex)
      return true
    }

    const delta = event.key === "ArrowDown" ? 1 : -1
    const next = (state.activeIndex + delta + state.items.length) % state.items.length
    this.setActiveIndex(next)
    return true
  }

  private apply<Item extends SuggestionMenuItem>(
    options: SuggestionMenuOpenOptions<Item>,
    activeIndex: number
  ) {
    if (options.items.length === 0) {
      // 没有候选时收起浮层，但保留 source：继续输入还能再次命中。
      this.select = null
      this.state = null
      this.listener(null)
      return
    }

    const anchor = options.rect
      ? { bottom: options.rect.bottom, left: options.rect.left, top: options.rect.top }
      : (this.state?.anchor ?? { bottom: 0, left: 0, top: 0 })

    this.select = (index) => {
      const item = options.items[index]
      if (item) options.onSelect(item)
    }
    this.state = {
      activeIndex: Math.min(Math.max(activeIndex, 0), options.items.length - 1),
      anchor,
      ariaLabel: options.ariaLabel,
      items: options.items,
    }
    this.listener(this.state)
  }
}

function sameKeys(current: SuggestionMenuItem[], next: SuggestionMenuItem[]) {
  return (
    current.length === next.length &&
    current.every((item, index) => item.key === next[index].key)
  )
}
