import { useMemo, useState, type CSSProperties } from "react"
import {
  CopyIcon,
  PlusIcon,
  SparklesIcon,
} from "lucide-react"

import { StatusBadge } from "@/components/shard/status-badge"
import { TagBadge } from "@/components/shard/tag-badge"
import { Button } from "@astryxdesign/core/Button"
import { Divider } from "@astryxdesign/core/Divider"
import { HStack } from "@astryxdesign/core/HStack"
import { FragmentBody } from "@/components/shard/fragment-body"
import { Stack, StackItem } from "@astryxdesign/core/Stack"
import { TextInput } from "@astryxdesign/core/TextInput"
import { normalizeTag, toggleTaskLine } from "@/lib/editor-format"
import type { Fragment } from "@/types"

const panelTitleStyle: CSSProperties = {
  fontSize: "var(--font-size-lg)",
  fontWeight: "var(--font-weight-bold)",
}

const sectionHeadingStyle: CSSProperties = {
  fontSize: "var(--font-size-sm)",
  fontWeight: "var(--font-weight-bold)",
}

const infoGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "72px 1fr",
  rowGap: "var(--shard-space-3)",
  fontSize: "var(--font-size-sm)",
}

const labelStyle: CSSProperties = {
  color: "var(--muted-foreground)",
}

const truncateStyle: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
}

const valueStyle: CSSProperties = {
  textAlign: "right",
  fontWeight: "var(--font-weight-medium)",
}

const valueMonoStyle: CSSProperties = {
  ...truncateStyle,
  textAlign: "right",
  fontFamily: "var(--font-family-code)",
  fontSize: "var(--font-size-xs)",
}

const valueTruncateStyle: CSSProperties = {
  ...truncateStyle,
  textAlign: "right",
  fontSize: "var(--font-size-xs)",
}

const valueMutedTruncateStyle: CSSProperties = {
  ...valueTruncateStyle,
  color: "var(--muted-foreground)",
}

const contentBoxStyle: CSSProperties = {
  minHeight: 112,
  borderRadius: "var(--shard-radius-card)",
  border: "1px solid var(--border)",
  background: "color-mix(in srgb, var(--muted) 55%, transparent)",
  padding: "var(--shard-space-3)",
}

const aiSuggestionBoxStyle: CSSProperties = {
  borderRadius: "var(--shard-radius-card)",
  border: "1px solid rgb(var(--shard-primary-rgb) / var(--shard-alpha-34))",
  background: "rgb(var(--shard-primary-rgb) / var(--shard-alpha-8))",
  padding: "var(--shard-space-3)",
  fontSize: "var(--font-size-sm)",
  lineHeight: "24px",
  color: "var(--shard-sapphire-text)",
}

interface FragmentDetailPanelProps {
  fragment: Fragment | null
  onUpdateContent?: (id: string, content: string, tags: string[]) => void | Promise<void>
  onUpdateTags: (id: string, tags: string[]) => void | Promise<void>
  vaultPath: string
}

export function FragmentDetailPanel({
  fragment,
  onUpdateContent,
  onUpdateTags,
  vaultPath,
}: FragmentDetailPanelProps) {
  const [draftTag, setDraftTag] = useState("")

  const createdTime = useMemo(() => {
    if (!fragment) return ""
    return new Date(fragment.createdAt).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
  }, [fragment])

  if (!fragment) {
    return (
      <Stack
        as="aside"
        minHeight={0}
        paddingInline={5}
        paddingBlock={6}
        style={{ background: "var(--card)" }}
      >
        <div style={panelTitleStyle}>片段详情</div>
        <Divider style={{ marginBlock: "var(--shard-space-5)" }} />
        <StackItem size="fill">
          <div
            style={{
              display: "flex",
              height: "100%",
              alignItems: "center",
              justifyContent: "center",
              textAlign: "center",
              fontSize: "var(--font-size-sm)",
              fontWeight: "var(--font-weight-medium)",
              color: "var(--muted-foreground)",
            }}
          >
            选择一张卡片查看详情。
          </div>
        </StackItem>
      </Stack>
    )
  }

  function addTag() {
    if (!fragment) return
    const next = normalizeTag(draftTag)
    if (!next || fragment.tags.includes(next)) {
      setDraftTag("")
      return
    }
    setDraftTag("")
    void onUpdateTags(fragment.id, [...fragment.tags, next])
  }

  function removeTag(tag: string) {
    if (!fragment) return
    const nextTags = fragment.tags.filter((current) => current !== tag)
    void onUpdateTags(fragment.id, nextTags.length ? nextTags : ["inbox"])
  }

  function toggleTask(lineIndex: number) {
    if (!fragment || !onUpdateContent) return
    const nextContent = toggleTaskLine(fragment.content, lineIndex)
    if (nextContent === fragment.content) return
    void onUpdateContent(fragment.id, nextContent, fragment.tags)
  }

  return (
    <Stack as="aside" minHeight={0} style={{ background: "var(--card)" }}>
      <HStack hAlign="between" vAlign="center" paddingInline={5} paddingBlock={5}>
        <div style={panelTitleStyle}>片段详情</div>
        <Button
          icon={<CopyIcon />}
          isIconOnly
          label="复制片段 ID"
          size="sm"
          variant="ghost"
        />
      </HStack>
      <Divider />

      <StackItem size="fill" isScrollable>
        <Stack gap={5} paddingInline={5} paddingBlock={5}>
          <Stack as="section" gap={3}>
            <h2 style={sectionHeadingStyle}>基本信息</h2>
            <dl style={infoGridStyle}>
              <dt style={labelStyle}>创建时间</dt>
              <dd style={valueStyle}>{createdTime}</dd>
              <dt style={labelStyle}>ID</dt>
              <dd style={valueMonoStyle}>{fragment.id}</dd>
              <dt style={labelStyle}>文件</dt>
              <dd style={valueTruncateStyle}>{fragment.path}</dd>
            </dl>
          </Stack>

          <Divider />

          <Stack as="section" gap={3}>
            <HStack hAlign="between" vAlign="center">
              <h2 style={sectionHeadingStyle}>标签</h2>
            </HStack>
            <HStack wrap="wrap" gap={2}>
              {fragment.tags.map((tag) => (
                <TagBadge
                  key={tag}
                  onRemove={removeTag}
                  removable
                  tag={tag}
                />
              ))}
            </HStack>
            <HStack gap={2}>
              <StackItem size="fill">
                <TextInput
                  isLabelHidden
                  label="添加标签"
                  onChange={(value) => setDraftTag(value)}
                  onEnter={addTag}
                  placeholder="添加标签"
                  value={draftTag}
                />
              </StackItem>
              <Button
                icon={<PlusIcon />}
                isIconOnly
                label="添加标签"
                onClick={addTag}
                size="sm"
                variant="secondary"
              />
            </HStack>
          </Stack>

          <Divider />

          <Stack as="section" gap={3}>
            <HStack hAlign="between" vAlign="center">
              <h2 style={sectionHeadingStyle}>Git 状态</h2>
              <StatusBadge status={fragment.gitStatus} />
            </HStack>
            <dl style={infoGridStyle}>
              <dt style={labelStyle}>Vault</dt>
              <dd style={valueTruncateStyle}>{vaultPath}</dd>
              <dt style={labelStyle}>错误</dt>
              <dd style={valueMutedTruncateStyle}>
                {fragment.error || "无"}
              </dd>
            </dl>
          </Stack>

          <Divider />

          <Stack as="section" gap={3}>
            <h2 style={sectionHeadingStyle}>内容</h2>
            <div style={contentBoxStyle}>
              <FragmentBody
                as="div"
                content={fragment.content}
                downloadableImages
                onTaskToggle={onUpdateContent ? toggleTask : undefined}
                renderImages
                vaultPath={vaultPath}
              />
            </div>
          </Stack>

          <Divider />

          <Stack as="section" gap={3}>
            <HStack hAlign="between" vAlign="center">
              <h2 style={sectionHeadingStyle}>AI 建议</h2>
              <Button
                icon={<SparklesIcon />}
                isIconOnly
                label="整理片段"
                size="sm"
                variant="ghost"
              />
            </HStack>
            <div style={aiSuggestionBoxStyle}>
              AI 整理会在后续版本中接入本地 Codex / Claude Code CLI。创建片段时不会等待 AI。
            </div>
          </Stack>
        </Stack>
      </StackItem>

      <HStack
        gap={3}
        paddingInline={5}
        paddingBlock={5}
        style={{ borderTop: "1px solid var(--border)" }}
      >
        <Button style={{ flex: 1 }} label="归档片段" variant="secondary" />
        <Button style={{ flex: 1 }} label="编辑片段" variant="secondary" />
      </HStack>
    </Stack>
  )
}
