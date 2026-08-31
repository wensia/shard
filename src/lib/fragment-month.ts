import type { Fragment } from "@/types"

export function isFragmentInMonth(fragment: Fragment, month: string) {
  if (fragment.kind !== "fragment" || fragment.archived || fragment.lockbox) {
    return false
  }
  const pathMonth = fragment.path.match(/^fragments\/(\d{4})\/(\d{2})\//u)
  if (pathMonth) return `${pathMonth[1]}-${pathMonth[2]}` === month
  if (!fragment.path.startsWith("fragments/")) return false
  return fragment.createdAt.slice(0, 7) === month
}
