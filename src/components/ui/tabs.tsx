import "./tabs.css"

/**
 * 页签文字。选中时字重变为 500，TabLabel 用隐藏的加粗副本预先占住宽度，
 * 避免切换页签时后面的页签被挤动。样式与用法见 tabs.css。
 */
export function TabLabel({ children }: { children: string }) {
  return (
    <span className="shard-tab-label" data-label={children}>
      {children}
    </span>
  )
}
