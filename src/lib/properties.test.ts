import { describe, expect, it } from "vitest"

import {
  buildPropertyRequestValue,
  parsePropertyList,
  validatePropertyDate,
  validatePropertyDateTime,
  validatePropertyKey,
  validatePropertyNumber,
} from "@/lib/properties"

describe("属性键", () => {
  it.each(["客户等级", "follow-up", "score_2", "阶段２"])(
    "接受 Unicode 字母数字、下划线和连字符：%s",
    (key) => expect(validatePropertyKey(key)).toBeNull()
  )

  it("拒绝空值、超长、非法字符、连字符开头和系统保留名", () => {
    expect(validatePropertyKey("")).toContain("不能为空")
    expect(validatePropertyKey("字".repeat(65))).toContain("64")
    expect(validatePropertyKey("-stage")).toContain("不能以")
    expect(validatePropertyKey("follow up")).toContain("只能包含")
    expect(validatePropertyKey("updated_at")).toContain("系统保留名")
  })

  it("按 Unicode 字符而不是 UTF-16 码元计算长度", () => {
    expect(validatePropertyKey("𐐀".repeat(64))).toBeNull()
    expect(validatePropertyKey("𐐀".repeat(65))).toContain("64")
  })
})

describe("属性值构造", () => {
  it("校验数字格式、i64 整数范围和有限小数", () => {
    expect(validatePropertyNumber("-9223372036854775808")).toBeNull()
    expect(validatePropertyNumber("9223372036854775807")).toBeNull()
    expect(validatePropertyNumber("9223372036854775808")).toContain("数字格式无效")
    expect(validatePropertyNumber("1.50")).toBeNull()
    expect(validatePropertyNumber("1e3")).toContain("数字格式无效")
    expect(validatePropertyNumber(`${"9".repeat(309)}.1`)).toContain("数字格式无效")
    expect(buildPropertyRequestValue("number", " 1.50 ")).toEqual({
      type: "number",
      value: "1.50",
    })
  })

  it("校验真实日期并构造 YYYY-MM-DD", () => {
    expect(validatePropertyDate("2024-02-29")).toBeNull()
    expect(validatePropertyDate("2023-02-29")).toBe("日期无效。")
    expect(validatePropertyDate("2026-9-28")).toContain("YYYY-MM-DD")
    expect(buildPropertyRequestValue("date", "2026-09-28")).toEqual({
      type: "date",
      value: "2026-09-28",
    })
  })

  it("校验本地日期时间并保留分钟精度", () => {
    expect(validatePropertyDateTime("2026-09-28T23:59")).toBeNull()
    expect(validatePropertyDateTime("2026-09-28T24:00")).toBe("日期时间无效。")
    expect(validatePropertyDateTime("2026-02-29T08:30")).toBe("日期时间无效。")
    expect(buildPropertyRequestValue("datetime", "2026-09-28T08:05")).toEqual({
      type: "datetime",
      value: "2026-09-28T08:05",
    })
  })

  it("按中英文逗号拆分列表并清理空项", () => {
    expect(parsePropertyList("甲, 乙，丙 ,,， 丁 ")).toEqual(["甲", "乙", "丙", "丁"])
    expect(buildPropertyRequestValue("list", "甲，乙, 丙")).toEqual({
      type: "list",
      value: ["甲", "乙", "丙"],
    })
  })

  it("构造文本、勾选、链接与空值", () => {
    expect(buildPropertyRequestValue("text", "00123")).toEqual({
      type: "text",
      value: "00123",
    })
    expect(buildPropertyRequestValue("checkbox", false)).toEqual({
      type: "checkbox",
      value: false,
    })
    expect(buildPropertyRequestValue("link", "目标")).toEqual({
      type: "link",
      value: "[[目标]]",
    })
    expect(buildPropertyRequestValue("text", "")).toEqual({
      type: "text",
      value: null,
    })
  })
})
