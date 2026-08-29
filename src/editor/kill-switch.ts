// 临时迁移开关：IME 真机门禁通过后随旧 textarea 实现一起删除。
export function isLegacyEditorEnabled() {
  const localOverride =
    typeof localStorage !== "undefined"
      ? localStorage.getItem("shard.editor")
      : null

  return (
    localOverride === "legacy" ||
    import.meta.env.VITE_SHARD_EDITOR === "legacy"
  )
}
