import type { SVGProps } from "react"

export function ShardZenIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
      {...props}
    >
      <path
        d="M4.8 17.35h8.75l-4.3-4.25V6.55L4.8 9.75v7.6Z"
        fill="currentColor"
        fillOpacity="0.1"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M9.25 6.55 19 3.85 13.55 17.35"
        stroke="currentColor"
        strokeOpacity="0.38"
        strokeWidth="1.4"
      />
      <path
        d="M13.55 17.35 19 3.85 10.75 13.1"
        fill="var(--shard-sapphire)"
        fillOpacity="0.3"
        stroke="var(--shard-sapphire)"
        strokeWidth="1.6"
      />
      <path
        d="M7.25 20.15h8.55"
        stroke="currentColor"
        strokeOpacity="0.34"
        strokeWidth="1.4"
      />
    </svg>
  )
}
