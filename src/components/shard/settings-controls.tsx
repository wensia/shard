import type { ReactNode } from "react"

import styles from "./settings-controls.module.css"

/*
 * 设置面板的版式积木：分区 → 分组卡片 → 设置行。
 * 版式参照 Tolaria 的设置面板（左侧锚点导航 + 单页滚动 + 「名称说明 | 控件」行），
 * 代码按 kiln token 自写，不搬运其源码。
 */

type ControlWidth = "auto" | "compact" | "default" | "wide"

export function SettingsBlock({
  children,
  id,
  title,
}: {
  children: ReactNode
  id: string
  title: string
}) {
  const headingId = `settings-heading-${id}`
  return (
    <section
      aria-labelledby={headingId}
      className={styles.block}
      data-settings-section={id}
    >
      <h3 className={styles.blockTitle} id={headingId}>
        {title}
      </h3>
      {children}
    </section>
  )
}

export function SettingsGroup({
  children,
  busy,
}: {
  children: ReactNode
  busy?: boolean
}) {
  return (
    <div aria-busy={busy || undefined} className={styles.group}>
      {children}
    </div>
  )
}

/** 整行自由内容（忙碌提示、说明文字），与设置行共用内边距与分隔线。 */
export function SettingsGroupItem({ children }: { children: ReactNode }) {
  return <div className={styles.item}>{children}</div>
}

export function SettingsRow({
  children,
  controlWidth = "default",
  description,
  label,
  labelId,
}: {
  children?: ReactNode
  controlWidth?: ControlWidth
  description?: ReactNode
  label: ReactNode
  labelId?: string
}) {
  return (
    <div className={`${styles.item} ${styles.row}`} data-control-width={controlWidth}>
      <div className={styles.rowText}>
        <div className={styles.rowLabel} id={labelId}>
          {label}
        </div>
        {description ? (
          <div className={styles.rowDescription}>{description}</div>
        ) : null}
      </div>
      {children ? (
        <div className={styles.control} data-width={controlWidth}>
          {children}
        </div>
      ) : null}
    </div>
  )
}

/** 路径、命令示例等需要整段选中复制的等宽文本。 */
export function SettingsMono({ children }: { children: ReactNode }) {
  return <span className={styles.mono}>{children}</span>
}

export interface SegmentedOption<Value extends string> {
  icon?: ReactNode
  label: string
  value: Value
}

/**
 * 两三个互斥选项的分段轨道（kiln SegmentedControl 语言）：
 * 外框即控件高度，激活片是白底 + 卡片阴影 + 品牌文字，暗色下补选中短横。
 */
export function SettingsSegmented<Value extends string>({
  ariaLabel,
  onChange,
  options,
  value,
}: {
  ariaLabel: string
  onChange: (value: Value) => void
  options: SegmentedOption<Value>[]
  value: Value
}) {
  return (
    <div aria-label={ariaLabel} className={styles.segmentTrack} role="group">
      {options.map((option) => (
        <button
          aria-pressed={option.value === value}
          className={styles.segment}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.icon}
          <span className={styles.segmentLabel}>{option.label}</span>
        </button>
      ))}
    </div>
  )
}
