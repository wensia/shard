import { describe, expect, it } from "vitest"

import { decodeCsvBytes, parseCsv, parseCsvBytes } from "@/lib/csv"

describe("parseCsv", () => {
  it("解析 RFC4180 的逗号、转义引号与单元格换行", () => {
    expect(
      parseCsv('name,note\r\n"张三","第一行\r\n第二行"\r\n"李""四",上海\r\n')
    ).toEqual([
      ["name", "note"],
      ["张三", "第一行\r\n第二行"],
      ['李"四', "上海"],
    ])
  })

  it("保留空字段、空记录和末尾空字段", () => {
    expect(parseCsv("a,,c\n\n1,2,")).toEqual([
      ["a", "", "c"],
      [""],
      ["1", "2", ""],
    ])
  })

  it.each([
    ['a,"未闭合', "未闭合"],
    ['a,b"c', "未加引号"],
    ['a,"b"x', "结束引号后"],
  ])("拒绝非 RFC4180 输入：%s", (source, message) => {
    expect(() => parseCsv(source)).toThrow(message)
  })
})

describe("decodeCsvBytes", () => {
  it("识别 UTF-8 BOM 并在解析前移除", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("a,b\r\n1,2")])

    expect(parseCsvBytes(bytes)).toEqual({
      encoding: "utf-8-bom",
      records: [["a", "b"], ["1", "2"]],
    })
  })

  it("UTF-8 校验失败时按 GBK 只读转码", () => {
    const bytes = new Uint8Array([
      0xd0, 0xd5, 0xc3, 0xfb, 0x2c, 0xb3, 0xc7, 0xca, 0xd0, 0x0d, 0x0a,
      0xd5, 0xc5, 0xc8, 0xfd, 0x2c, 0xb1, 0xb1, 0xbe, 0xa9,
    ])

    expect(decodeCsvBytes(bytes)).toEqual({
      encoding: "gbk",
      text: "姓名,城市\r\n张三,北京",
    })
  })
})
