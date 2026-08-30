export function LibraryShell() {
  return (
    <section
      aria-label="资料库"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background"
    >
      <header
        className="shard-content-inset shrink-0 border-b border-border bg-[color:var(--topbar)] backdrop-blur"
        data-tauri-drag-region
        style={{
          boxShadow: "var(--shadow-topbar)",
          paddingBlock: "var(--space-4)",
        }}
      >
        <h1 className="shard-content-measure text-[length:var(--text-page-title)] font-semibold">
          资料库
        </h1>
      </header>
      <div className="min-h-0 flex-1" />
    </section>
  )
}
