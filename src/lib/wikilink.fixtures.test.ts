import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { stripMarkdownHardBreaks } from "@shard/markdown/core"
import { describe, expect, it } from "vitest"

import { deriveNoteTitle, type ContentKind } from "@/lib/content-kind"
import {
  buildCsvWikilinkCandidates,
  buildMindMapWikilinkCandidates,
  buildWikilinkCandidates,
  isCsvWikilinkTarget,
  normalizeWikilinkTarget,
  parseWikilinks,
  resolveWikilinkTarget,
  type WikilinkCandidate,
} from "@/lib/wikilink"
import type { Fragment, FragmentRelation } from "@/types"

/**
 * 与 Rust 移植（`crates/shard-core/src/wikilink.rs`）共用的 wikilink 用例。
 * Rust 那一侧是 `crates/shard-core/tests/wikilink_fixtures.rs`，两边读同一份 JSON。
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const FIXTURE_PATH = "crates/shard-core/tests/fixtures/wikilink-cases.json"

interface FixtureDocument {
  content: string
  id: string
  kind: ContentKind
  lockbox?: boolean
  path: string
}

interface FixtureLink {
  alias: string | null
  embed: boolean
  target: string
  text: string
}

interface FixtureHit {
  fragmentId?: string
  kind: WikilinkCandidate["kind"]
  path?: string
}

interface FixtureRelation {
  origin: FragmentRelation["origin"]
  targetId: string
}

interface WikilinkFixture {
  csvTarget: { expected: boolean; input: string }[]
  hardBreaks: { content: string; expected: string }[]
  normalize: { expected: string; input: string }[]
  noteTitle: {
    content: string
    expected: string
    name: string
    repeatPrefix?: { count: number; text: string }
  }[]
  parse: { content: string; links: FixtureLink[]; name: string }[]
  relations: {
    corpus: FixtureDocument[]
    currentRelations: FixtureRelation[]
    expectedAdded?: string[]
    expectedRelations?: FixtureRelation[]
    expectedRemoved?: string[]
    expectedTargets: string[] | null
    name: string
    source: FixtureDocument
  }[]
  resolve: {
    candidates: {
      fragmentId: string | null
      kind: WikilinkCandidate["kind"]
      matchKeys: string[]
      path: string | null
      target: string
    }[]
    csvFiles: { name: string; path: string }[]
    fragments: FixtureDocument[]
    lookups: { expected: FixtureHit | null; target: string }[]
    mindMaps: { path: string; title: string }[]
    name: string
  }[]
}

const fixture = JSON.parse(
  readFileSync(path.join(REPO_ROOT, FIXTURE_PATH), "utf8")
) as WikilinkFixture

function toFragment(document: FixtureDocument): Fragment {
  return {
    archived: document.path.startsWith(".trash/"),
    category: null,
    content: document.content,
    createdAt: "2026-01-01T00:00:00+08:00",
    error: null,
    gitStatus: "saved",
    id: document.id,
    kind: document.kind,
    lockbox: document.lockbox ?? false,
    path: document.path,
    pinned: false,
    tags: [],
    updatedAt: "2026-01-01T00:00:00+08:00",
  }
}

/**
 * `workbench-shell.tsx` 的 wikilink 目标推导：新建 937-953 行（`[...fragments, created]`），
 * 更新 1170-1186 行（替换成保存后的版本）。密匣文档不做同步（913-927、1170 行）。
 */
function deriveWikilinkTargets(
  source: FixtureDocument,
  corpus: readonly FixtureDocument[]
): string[] | null {
  if (source.lockbox) return null
  const documents = corpus.some((document) => document.id === source.id)
    ? corpus.map((document) => (document.id === source.id ? source : document))
    : [...corpus, source]
  const candidates = buildWikilinkCandidates(documents.map(toFragment))
  return Array.from(
    new Set(
      parseWikilinks(source.content)
        .map((link) => resolveWikilinkTarget(link.target, candidates)?.fragmentId)
        .filter(
          (targetId): targetId is string => Boolean(targetId) && targetId !== source.id
        )
    )
  )
}

/** `workbench-shell.tsx` 1187-1200 行的增删计划。 */
function planWikilinkSync(current: readonly FixtureRelation[], nextTargets: readonly string[]) {
  const next = new Set(nextTargets)
  const existing = new Set(current.map((relation) => relation.targetId))
  return {
    added: Array.from(next).filter((targetId) => !existing.has(targetId)),
    removed: current
      .filter((relation) => relation.origin === "wikilink" && !next.has(relation.targetId))
      .map((relation) => relation.targetId),
  }
}

/** 后端 `unlink_fragments_in_vault` / `link_fragments_in_vault` 落到关系列表上的效果。 */
function applyWikilinkSync(
  current: readonly FixtureRelation[],
  sync: { added: string[]; removed: string[] }
) {
  let related = [...current]
  for (const targetId of sync.removed) {
    related = related.filter((relation) => relation.targetId !== targetId)
  }
  for (const targetId of sync.added) {
    if (!related.some((relation) => relation.targetId === targetId)) {
      related.push({ origin: "wikilink", targetId })
    }
  }
  return related
}

describe("wikilink 共享 fixture", () => {
  it.each(fixture.parse.map((item) => [item.name, item] as const))(
    "parse：%s",
    (_name, item) => {
      expect(
        parseWikilinks(item.content).map((link) => ({
          alias: link.alias ?? null,
          embed: link.embed ?? false,
          target: link.target,
          text: item.content.slice(link.from, link.to),
        }))
      ).toEqual(item.links)
    }
  )

  it.each(fixture.normalize.map((item) => [JSON.stringify(item.input), item] as const))(
    "normalize：%s",
    (_name, item) => {
      expect(normalizeWikilinkTarget(item.input)).toBe(item.expected)
    }
  )

  it.each(fixture.csvTarget.map((item) => [JSON.stringify(item.input), item] as const))(
    "csvTarget：%s",
    (_name, item) => {
      expect(isCsvWikilinkTarget(item.input)).toBe(item.expected)
    }
  )

  it.each(fixture.noteTitle.map((item) => [item.name, item] as const))(
    "noteTitle：%s",
    (_name, item) => {
      const prefix = item.repeatPrefix
        ? item.repeatPrefix.text.repeat(item.repeatPrefix.count)
        : ""
      expect(deriveNoteTitle(prefix + item.content)).toBe(item.expected)
    }
  )

  it.each(fixture.hardBreaks.map((item) => [JSON.stringify(item.content), item] as const))(
    "hardBreaks：%s",
    (_name, item) => {
      expect(stripMarkdownHardBreaks(item.content, 32_000)).toBe(item.expected)
    }
  )

  it.each(fixture.resolve.map((item) => [item.name, item] as const))(
    "resolve：%s",
    (_name, item) => {
      const candidates = [
        ...buildWikilinkCandidates(item.fragments.map(toFragment)),
        ...buildCsvWikilinkCandidates(item.csvFiles),
        ...buildMindMapWikilinkCandidates(item.mindMaps),
      ]
      expect(
        candidates.map((candidate) => ({
          fragmentId: candidate.fragmentId ?? null,
          kind: candidate.kind,
          matchKeys: candidate.matchKeys,
          path: candidate.path ?? null,
          target: candidate.target,
        }))
      ).toEqual(item.candidates)

      for (const lookup of item.lookups) {
        const resolved = resolveWikilinkTarget(lookup.target, candidates)
        expect(
          resolved
            ? {
                kind: resolved.kind,
                ...(resolved.fragmentId ? { fragmentId: resolved.fragmentId } : {}),
                ...(resolved.path ? { path: resolved.path } : {}),
              }
            : null,
          JSON.stringify(lookup.target)
        ).toEqual(lookup.expected)
      }
    }
  )

  it.each(fixture.relations.map((item) => [item.name, item] as const))(
    "relations：%s",
    (_name, item) => {
      const targets = deriveWikilinkTargets(item.source, item.corpus)
      expect(targets).toEqual(item.expectedTargets)
      if (!targets) return

      const sync = planWikilinkSync(item.currentRelations, targets)
      expect(sync.removed).toEqual(item.expectedRemoved)
      expect(sync.added).toEqual(item.expectedAdded)
      expect(applyWikilinkSync(item.currentRelations, sync)).toEqual(item.expectedRelations)
    }
  )
})
