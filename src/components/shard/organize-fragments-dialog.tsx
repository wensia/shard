import { CircleAlertIcon } from "@/components/icons"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import type { OrganizeTemplate } from "@/lib/api"
import { cn } from "@/lib/utils"

export const ORGANIZE_TEMPLATES: readonly {
  id: OrganizeTemplate
  label: string
  description: string
}[] = [
  { id: "summary", label: "摘要", description: "提炼主题、结论与待办" },
  { id: "article", label: "文章", description: "组织成连贯的长文结构" },
  { id: "weekly", label: "周报", description: "归纳进展、问题与下一步" },
]

interface OrganizeFragmentsDialogProps {
  error: string | null
  isOpen: boolean
  isRunning: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: () => void
  onTargetChange: (target: string) => void
  onTemplateChange: (template: OrganizeTemplate) => void
  selectedCount: number
  target: string
  template: OrganizeTemplate
}

export function OrganizeFragmentsDialog({
  error,
  isOpen,
  isRunning,
  onOpenChange,
  onSubmit,
  onTargetChange,
  onTemplateChange,
  selectedCount,
  target,
  template,
}: OrganizeFragmentsDialogProps) {
  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!isRunning) onOpenChange(open)
      }}
    >
      <DialogContent
        aria-busy={isRunning ? true : undefined}
        showCloseButton={!isRunning}
      >
        <DialogHeader>
          <DialogTitle>整理为笔记</DialogTitle>
          <DialogDescription>
            将已选 {selectedCount} 条公开碎片交给本机 Codex CLI，生成一篇新笔记。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-[var(--field-rhythm)]">
          <div className="flex flex-col gap-2">
            <label
              className="text-[var(--text-meta)] font-medium"
              htmlFor="organize-target"
            >
              目标描述
            </label>
            <Textarea
              autoFocus
              disabled={isRunning}
              id="organize-target"
              onChange={(event) => onTargetChange(event.target.value)}
              placeholder="例如：整理本周产品决策，突出结论和后续行动"
              rows={3}
              value={target}
            />
          </div>

          <fieldset className="flex flex-col gap-2" disabled={isRunning}>
            <legend className="text-[var(--text-meta)] font-medium">模板</legend>
            <div
              aria-label="笔记模板"
              className="grid grid-cols-3 gap-2"
              role="radiogroup"
            >
              {ORGANIZE_TEMPLATES.map((option) => {
                const selected = template === option.id
                return (
                  <button
                    aria-checked={selected}
                    className={cn(
                      "min-w-0 rounded-[var(--radius-control)] border bg-card px-3 py-2 text-left transition-[border-color,background-color,box-shadow] outline-none focus-visible:ring-3 focus-visible:ring-ring/[var(--shard-alpha-55)] disabled:cursor-not-allowed disabled:opacity-[var(--shard-alpha-55)]",
                      selected
                        ? "border-primary bg-primary/[var(--shard-alpha-8)]"
                        : "border-input hover:bg-muted"
                    )}
                    key={option.id}
                    onClick={() => onTemplateChange(option.id)}
                    role="radio"
                    type="button"
                  >
                    <span className="block text-[var(--text-body)] font-medium">
                      {option.label}
                    </span>
                    <span className="mt-1 block text-[var(--text-tiny)] leading-[var(--leading-normal)] text-muted-foreground">
                      {option.description}
                    </span>
                  </button>
                )
              })}
            </div>
          </fieldset>

          {error ? (
            <div
              className="flex items-start gap-2 rounded-[var(--radius-control)] border border-destructive/30 bg-destructive/[var(--shard-alpha-8)] px-3 py-2 text-[var(--text-meta)] leading-5 text-destructive"
              role="alert"
            >
              <CircleAlertIcon
                aria-hidden="true"
                className="mt-0.5 size-3.5 shrink-0"
              />
              <span className="min-w-0 flex-1 text-pretty">{error}</span>
              <Button
                onClick={onSubmit}
                size="sm"
                type="button"
                variant="outline"
              >
                重试
              </Button>
            </div>
          ) : null}

          {isRunning ? (
            <p
              aria-live="polite"
              className="m-0 text-[var(--text-meta)] text-muted-foreground"
            >
              正在调用本机 Codex CLI 整理所选碎片，请稍候…
            </p>
          ) : null}
        </div>

        <DialogFooter className="sm:flex-row sm:justify-end">
          <Button
            disabled={isRunning}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            取消
          </Button>
          <Button
            disabled={isRunning || target.trim().length === 0}
            onClick={onSubmit}
            type="button"
          >
            {isRunning ? "正在整理…" : "生成笔记"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
