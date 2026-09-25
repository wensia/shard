import {
  CircleAlertIcon,
  FileIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  GitBranchIcon,
  Grid2X2Icon,
  LockKeyholeIcon,
  SearchIcon,
  TableIcon,
  WorkflowIcon,
  XIcon,
  type LucideIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import type {
  SearchHit,
  SearchKind,
  SearchMode,
  SearchSession,
  SearchTextPart,
} from "@/lib/search-contract";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { readPublicOpenRecent } from "@/lib/search-recent";

import styles from "./search-palette.module.css";

export interface SearchPaletteProps {
  session: SearchSession;
  onModeChange(mode: SearchMode): void;
  onQueryChange(query: string): void;
  onSelect(hit: SearchHit): void;
  onClose(): void;
  onFilterFragments?(): void;
  onIncludeTrashChange?(includeTrash: boolean): void;
  onSelectedKeyChange?(key: string | null): void;
}

const KIND_ICON: Record<SearchKind, LucideIcon> = {
  canvas: Grid2X2Icon,
  csv: FileSpreadsheetIcon,
  document: FileTextIcon,
  flowchart: WorkflowIcon,
  fragment: FileIcon,
  mindmap: GitBranchIcon,
  note: FileTextIcon,
  outline: GitBranchIcon,
  table: TableIcon,
};

const KIND_LABEL: Record<SearchKind, string> = {
  canvas: "画布",
  csv: "CSV",
  document: "文档",
  flowchart: "流程图",
  fragment: "碎片",
  mindmap: "思维导图",
  note: "笔记",
  outline: "大纲",
  table: "表格",
};

export function SearchPalette({
  session,
  onClose,
  onFilterFragments,
  onIncludeTrashChange,
  onModeChange,
  onQueryChange,
  onSelect,
  onSelectedKeyChange,
}: SearchPaletteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const lastSubmittedValueRef = useRef(session.drafts[session.mode]);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const viewportRef = useRef<HTMLDivElement>(null);
  const [inputValue, setInputValue] = useState(session.drafts[session.mode]);
  const [selectedIndex, setSelectedIndex] = useState(() =>
    Math.max(
      0,
      session.hits.findIndex((hit) => hit.target.key === session.selectedKey),
    ),
  );

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    if (isComposingRef.current) return;
    const nextValue = session.drafts[session.mode];
    setInputValue(nextValue);
    lastSubmittedValueRef.current = nextValue;
  }, [session.drafts, session.mode]);

  useEffect(() => {
    const nextIndex = session.hits.findIndex(
      (hit) => hit.target.key === session.selectedKey,
    );
    setSelectedIndex(nextIndex >= 0 ? nextIndex : 0);
  }, [session.hits, session.selectedKey]);

  useEffect(() => {
    const selected = session.hits[selectedIndex];
    const viewport = viewportRef.current;
    const option = selected
      ? optionRefs.current.get(selected.target.key)
      : null;
    if (!viewport || !option) return;

    const viewportRect = viewport.getBoundingClientRect();
    const optionRect = option.getBoundingClientRect();
    if (optionRect.top < viewportRect.top) {
      viewport.scrollTop -= viewportRect.top - optionRect.top;
    } else if (optionRect.bottom > viewportRect.bottom) {
      viewport.scrollTop += optionRect.bottom - viewportRect.bottom;
    }
  }, [selectedIndex, session.hits]);

  const selectedHit = session.hits[selectedIndex] ?? null;
  const activeOptionId = selectedHit
    ? `search-palette-option-${selectedIndex}`
    : undefined;
  const openSectionTitle = useMemo(() => {
    if (
      session.mode !== "open" ||
      session.drafts.open.trim() ||
      session.hits.length === 0
    ) {
      return null;
    }

    const recent =
      session.scope === "public"
        ? readPublicOpenRecent(session.vaultPath)
        : new Map<string, number>();
    return session.hits.some((hit) => recent.has(hit.target.key))
      ? "最近打开"
      : "最近修改";
  }, [
    session.drafts.open,
    session.hits,
    session.mode,
    session.scope,
    session.vaultPath,
  ]);

  function selectIndex(index: number) {
    const hit = session.hits[index];
    if (!hit) return;
    setSelectedIndex(index);
    onSelectedKeyChange?.(hit.target.key);
  }

  function submitQuery(value: string) {
    if (lastSubmittedValueRef.current === value) return;
    lastSubmittedValueRef.current = value;
    onQueryChange(value);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (isComposingRef.current || event.nativeEvent.isComposing) {
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectIndex(Math.min(selectedIndex + 1, session.hits.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      selectIndex(Math.max(selectedIndex - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (selectedHit) onSelect(selectedHit);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open: boolean) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        aria-label="搜索"
        className={styles.palette}
        data-search-mode={session.mode}
        data-search-pending={session.pendingNavigation ? "true" : "false"}
        data-search-state={session.state}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">搜索</DialogTitle>
        <header className={styles.header} data-search-palette-header>
          <SearchIcon aria-hidden="true" className={styles.searchIcon} />
          <Input
            aria-activedescendant={activeOptionId}
            aria-autocomplete="list"
            aria-controls="search-palette-results"
            aria-expanded={session.hits.length > 0}
            aria-label="搜索内容"
            autoComplete="off"
            className={styles.input}
            onChange={(event) => {
              setInputValue(event.target.value);
              if (!isComposingRef.current) submitQuery(event.target.value);
            }}
            onCompositionEnd={(event) => {
              isComposingRef.current = false;
              const value = event.currentTarget.value;
              setInputValue(value);
              submitQuery(value);
            }}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              session.mode === "fullText"
                ? "搜索正文、标题或标签"
                : "搜索标题或路径"
            }
            ref={inputRef}
            role="combobox"
            value={inputValue}
          />
          <div aria-label="搜索模式" className={styles.modeGroup} role="group">
            <button
              aria-pressed={session.mode === "fullText"}
              className={styles.modeButton}
              onClick={() => onModeChange("fullText")}
              type="button"
            >
              全文
            </button>
            <button
              aria-pressed={session.mode === "open"}
              className={styles.modeButton}
              onClick={() => onModeChange("open")}
              type="button"
            >
              打开
            </button>
          </div>
          <Button
            aria-label="关闭搜索"
            className={styles.closeButton}
            onClick={onClose}
            size="icon"
            type="button"
            variant="ghost"
          >
            <XIcon aria-hidden="true" />
          </Button>
        </header>

        <ScrollArea
          aria-label="搜索结果区域"
          className={styles.resultsViewport}
          data-search-results-viewport
          viewportRef={viewportRef}
        >
          <div
            aria-busy={session.state === "indexing"}
            aria-label="搜索结果"
            className={styles.results}
            id="search-palette-results"
            role="listbox"
          >
            {session.hits.length > 0 ? (
              <>
                {openSectionTitle ? (
                  <div
                    aria-hidden="true"
                    className={styles.sectionTitle}
                    data-search-section-title
                    role="presentation"
                  >
                    {openSectionTitle}
                  </div>
                ) : null}
                {session.hits.map((hit, index) => (
                  <SearchPaletteRow
                    hit={hit}
                    id={`search-palette-option-${index}`}
                    isSelected={index === selectedIndex}
                    key={hit.target.key}
                    mode={session.mode}
                    onOpen={() => onSelect(hit)}
                    onSelect={() => selectIndex(index)}
                    optionRef={(element) => {
                      if (element)
                        optionRefs.current.set(hit.target.key, element);
                      else optionRefs.current.delete(hit.target.key);
                    }}
                  />
                ))}
              </>
            ) : (
              <SearchPaletteState session={session} />
            )}
          </div>
        </ScrollArea>

        <footer className={styles.footer}>
          <span aria-live="polite" className={styles.count}>
            {formatResultCount(session)}
          </span>
          {session.state === "stale" ? (
            <span className={styles.staleStatus} role="status">
              结果可能已过期，正在更新
            </span>
          ) : null}
          <span className={styles.scope}>
            {session.scope === "lockbox" ? (
              <>
                <LockKeyholeIcon aria-hidden="true" />
                密匣空间
              </>
            ) : (
              "公开空间"
            )}
          </span>
          {session.scope === "public" &&
          session.mode === "fullText" &&
          onFilterFragments ? (
            <Button
              onClick={onFilterFragments}
              size="sm"
              type="button"
              variant="ghost"
            >
              筛选碎片
            </Button>
          ) : null}
          {session.mode === "fullText" && onIncludeTrashChange ? (
            <Button
              aria-pressed={session.includeTrash}
              onClick={() => onIncludeTrashChange(!session.includeTrash)}
              size="sm"
              type="button"
              variant={session.includeTrash ? "primary" : "outline"}
            >
              包含回收站
            </Button>
          ) : null}
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function SearchPaletteRow({
  hit,
  id,
  isSelected,
  mode,
  onOpen,
  onSelect,
  optionRef,
}: {
  hit: SearchHit;
  id: string;
  isSelected: boolean;
  mode: SearchMode;
  onOpen: () => void;
  onSelect: () => void;
  optionRef: (element: HTMLButtonElement | null) => void;
}) {
  const Icon = KIND_ICON[hit.target.kind];
  const isFragmentPreview =
    mode === "fullText" && hit.target.kind === "fragment";
  const titleParts = titlePartsForDisplay(
    hit.title,
    hit.titleParts,
    hit.preview,
  );
  const previewParts = withoutRepeatedTitlePrefix(hit.title, hit.preview);
  return (
    <button
      aria-selected={isSelected}
      className={
        mode === "fullText" ? styles.resultRowFullText : styles.resultRowOpen
      }
      data-selected={isSelected ? "true" : undefined}
      id={id}
      onClick={onOpen}
      onMouseEnter={onSelect}
      ref={optionRef}
      role="option"
      type="button"
    >
      <span className={styles.kindIcon} title={KIND_LABEL[hit.target.kind]}>
        <Icon aria-hidden="true" />
      </span>
      <span className={styles.resultText}>
        {isFragmentPreview ? (
          <span
            className={`${styles.preview} ${styles.fragmentPreview}`}
            data-search-result-content="fragment-preview"
          >
            <SearchText
              parts={hit.preview.length > 0 ? hit.preview : hit.titleParts}
            />
          </span>
        ) : (
          <>
            <span className={styles.resultTitle} data-search-result-title>
              <SearchText parts={titleParts} />
            </span>
            {mode === "fullText" && previewParts.length > 0 ? (
              <span className={styles.preview}>
                <SearchText parts={previewParts} />
              </span>
            ) : null}
          </>
        )}
      </span>
      <span className={styles.resultMeta}>
        {mode === "open"
          ? parentPath(hit.target.path)
          : formatUpdatedAt(hit.updatedAt)}
      </span>
    </button>
  );
}

function SearchText({ parts }: { parts: readonly SearchTextPart[] }) {
  return parts.map((part, index) =>
    part.hit ? (
      <mark key={index}>{part.text}</mark>
    ) : (
      <span key={index}>{part.text}</span>
    ),
  );
}

function withoutRepeatedTitlePrefix(
  title: string,
  parts: readonly SearchTextPart[],
): readonly SearchTextPart[] {
  if (
    !title ||
    !parts
      .map((part) => part.text)
      .join("")
      .startsWith(title)
  ) {
    return parts;
  }

  let remaining = title.length;
  const result: SearchTextPart[] = [];
  for (const part of parts) {
    if (remaining >= part.text.length) {
      remaining -= part.text.length;
      continue;
    }
    result.push({ ...part, text: part.text.slice(remaining) });
    remaining = 0;
  }

  while (result[0] && !result[0].text.trim()) result.shift();
  if (result[0]) {
    result[0] = {
      ...result[0],
      text: result[0].text.replace(/^\s+/u, ""),
    };
  }
  return result;
}

function titlePartsForDisplay(
  title: string,
  titleParts: readonly SearchTextPart[],
  previewParts: readonly SearchTextPart[],
): readonly SearchTextPart[] {
  if (titleParts.some((part) => part.hit)) return titleParts;
  if (
    !title ||
    !previewParts
      .map((part) => part.text)
      .join("")
      .startsWith(title)
  ) {
    return titleParts;
  }

  let remaining = title.length;
  const prefix: SearchTextPart[] = [];
  for (const part of previewParts) {
    if (remaining <= 0) break;
    const text = part.text.slice(0, remaining);
    if (text) prefix.push({ ...part, text });
    remaining -= text.length;
  }
  return remaining === 0 && prefix.some((part) => part.hit)
    ? prefix
    : titleParts;
}

function SearchPaletteState({ session }: { session: SearchSession }) {
  const query = session.drafts[session.mode].trim();
  const content = (() => {
    if (session.state === "locked") {
      return {
        description: "解锁密匣后才能读取这里的标题与正文。",
        title: "密匣已上锁",
      };
    }
    if (session.state === "indexing") {
      return {
        description: "索引准备好后会自动更新结果。",
        title: "正在准备搜索",
      };
    }
    if (session.state === "stale") {
      return {
        description: "正在重新核对已保存内容。",
        title: "搜索结果需要更新",
      };
    }
    if (session.state === "error") {
      return {
        description: searchErrorDescription(session),
        title: "搜索失败",
      };
    }
    if (session.state === "targetUnavailable") {
      return {
        description: "目标已移动、删除或暂不支持打开。",
        title: "目标不可用",
      };
    }
    if (session.state === "noResults") {
      return {
        description:
          session.mode === "fullText"
            ? "试试缩短关键词，或选择包含回收站。"
            : "试试标题、路径或拼音首字母。",
        title: query ? `没有找到“${query}”` : "没有可打开的内容",
      };
    }
    return {
      description: "输入关键词后，只搜索当前空间中已经保存的内容。",
      title: "搜索当前空间",
    };
  })();

  return (
    <div
      className={styles.state}
      role={session.state === "error" ? "alert" : "status"}
    >
      <CircleAlertIcon aria-hidden="true" />
      <strong>{content.title}</strong>
      <span>{content.description}</span>
    </div>
  );
}

function formatResultCount(session: SearchSession) {
  if (session.total === null) return "尚无结果";
  if (session.hits.length >= session.total) return `${session.total} 条`;
  return `显示前 ${session.hits.length} 条 · 共 ${session.total} 条`;
}

function searchErrorDescription(session: SearchSession) {
  if (session.error?.code === "invalidRequest") return "查询内容不符合要求。";
  if (session.error?.code === "io" && session.error.retryable) {
    return "读取暂时失败，修改关键词后可重试。";
  }
  return "当前无法完成查询。";
}

function parentPath(path: string) {
  const segments = path.split("/");
  segments.pop();
  return segments.join("/") || "资料库";
}

function formatUpdatedAt(value: string | null) {
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
  }).format(new Date(timestamp));
}
