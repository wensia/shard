import { forwardRef, type SVGProps } from "react"

interface SignatureIconProps extends SVGProps<SVGSVGElement> {
  size?: number | string
}

/**
 * 禅模式签名图标（design.md「签名图标」）：取景框里的一枚碎片。
 * 四角括号与 Lucide `focus` 同构（活动区 3–21、r=2 圆角），中心是 8×8 的正菱形碎片，
 * 因此与库图标共用同一套网格、线帽与光学重量。
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
      <path d="M3 7V5a2 2 0 0 1 2-2h2" />
      <path d="M17 3h2a2 2 0 0 1 2 2v2" />
      <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
      <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
      <path d="M12 8l4 4-4 4-4-4z" />
    </svg>
  )
)
ShardZenIcon.displayName = "ShardZenIcon"
