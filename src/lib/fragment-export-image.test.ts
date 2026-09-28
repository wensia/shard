import { describe, expect, it } from "vitest"

import { fragmentToBlocks } from "@/lib/fragment-export-image"
import type { Fragment } from "@/types"

describe("fragment export image", () => {
  it("分享图文字隐藏硬换行标记并保留空行", () => {
    const fragment = { content: "正文\\\n\\\n续行" } as Fragment
    expect(fragmentToBlocks(fragment)).toEqual([
      { kind: "text", text: "正文" },
      { kind: "blank" },
      { kind: "text", text: "续行" },
    ])
  })
})
