import { forwardRef, type SVGProps } from "react"

interface SignatureIconProps extends SVGProps<SVGSVGElement> {
  size?: number | string
}

/**
 * 禅模式签名图标（design.md「签名图标」）：悬浮的碎片 + 地平线。
 * 24 网格、单色描边；stroke-width 由 svg[data-shard-icon] 全局规则
 * 从 --shard-icon-stroke 取值，属性值只是无 CSS 环境的兜底。
 */
export const ShardZenIcon = forwardRef<SVGSVGElement, SignatureIconProps>(
  ({ size = 24, ...props }, ref) => (
    <svg
      ref={ref}
      data-shard-icon="zen"
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M12.5 4 17 8l-2.5 7.5H9L7 8.5Z" />
      <path d="M12.5 4 10.8 15.5" />
      <path d="M6 20h12" />
    </svg>
  )
)
ShardZenIcon.displayName = "ShardZenIcon"
