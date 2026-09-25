import { describe, expect, it } from "vitest"

import {
  coerceDatatableValue,
  createDatatableTemplate,
  datatableColumnsFromCsv,
  datatableRowsFromCsv,
  datatableToCsv,
  filterDatatableEntries,
  formatDatatableCell,
  groupDatatableEntries,
  isDatatableParseError,
  parseDatatableSource,
  serializeDatatableSpec,
  setDatatableCell,
  addDatatableColumn,
  addDatatableRow,
  removeDatatableColumn,
  removeDatatableRow,
  renameDatatableColumn,
  sortDatatableEntries,
  toDatatableEntries,
  writeDatatableView,
  type DatatableColumn,
  type DatatableSpec,
} from "@/lib/datatable"

const columns: DatatableColumn[] = [
  { key: "name", label: "名称", type: "text" },
  { key: "amount", label: "金额", type: "currency" },
  { key: "rate", label: "占比", type: "percent" },
  { key: "team", label: "小组", type: "badge" },
]

const spec: DatatableSpec = {
  columns,
  rows: [
    { amount: 1200, name: "乙项目", rate: 0.128, team: "北区" },
    { amount: 300, name: "甲项目", rate: 0.5, team: "南区" },
    { amount: null, name: "丙项目", rate: 0.05, team: "北区" },
  ],
}

function parsed(source: string) {
  const result = parseDatatableSource(source)
  if (isDatatableParseError(result)) throw new Error(result.error)
  return result
}

describe("数据表 JSON 校验", () => {
  it("补齐缺省的 rows 与 view，并保留列类型与对齐", () => {
    const result = parsed(
      '{"title":"季度","columns":[{"key":"a","label":"甲","type":"number","align":"right"}]}'
    )
    expect(result).toEqual({
      columns: [{ align: "right", key: "a", label: "甲", type: "number" }],
      rows: [],
      title: "季度",
    })
  })

  it("列缺 key、结构不对或两者都缺时报错", () => {
    expect(isDatatableParseError(parseDatatableSource("  "))).toBe(true)
    expect(isDatatableParseError(parseDatatableSource("{ not json"))).toBe(true)
    expect(isDatatableParseError(parseDatatableSource("[]"))).toBe(true)
    expect(isDatatableParseError(parseDatatableSource('{"columns":[{"label":"甲"}]}'))).toBe(true)
    expect(isDatatableParseError(parseDatatableSource('{"columns":"a"}'))).toBe(true)
    expect(isDatatableParseError(parseDatatableSource('{"rows":[]}'))).toBe(true)
    // 只有 src 也合法：列可以由 CSV 表头推出来。
    expect(isDatatableParseError(parseDatatableSource('{"src":"data/x.csv"}'))).toBe(false)
  })

  it("丢弃指向不存在列的视图状态", () => {
    const result = parsed(
      '{"columns":[{"key":"a","label":"甲"}],"view":{"sort":{"key":"b","direction":"desc"},"group":"a"}}'
    )
    expect(result.view).toEqual({ group: "a" })
  })

  it("序列化键序固定，src 供数据时不写回 rows", () => {
    expect(serializeDatatableSpec({ columns: [{ key: "a", label: "甲" }], rows: [{ a: 1 }] })).toBe(
      '{\n  "columns": [\n    {\n      "key": "a",\n      "label": "甲"\n    }\n  ],\n  "rows": [\n    {\n      "a": 1\n    }\n  ]\n}'
    )
    const fromCsv = serializeDatatableSpec({
      columns: [{ key: "a", label: "甲" }],
      rows: [{ a: 1 }],
      src: "data/x.csv",
    })
    expect(fromCsv).toContain('"src": "data/x.csv"')
    expect(fromCsv).not.toContain('"rows"')
  })

  it("模板是 2 列 2 行空表，且能被自己解析回来", () => {
    const template = parsed(createDatatableTemplate())
    expect(template.columns).toHaveLength(2)
    expect(template.rows).toEqual([
      { column1: "", column2: "" },
      { column1: "", column2: "" },
    ])
    expect(serializeDatatableSpec(template)).toBe(createDatatableTemplate())
  })
})

describe("数据表排序 / 分组 / 筛选", () => {
  const entries = toDatatableEntries(spec.rows)

  it("按数值列排序，空值永远沉底", () => {
    const ascending = sortDatatableEntries(entries, columns, { direction: "asc", key: "amount" })
    expect(ascending.map((entry) => entry.row.name)).toEqual(["甲项目", "乙项目", "丙项目"])

    const descending = sortDatatableEntries(entries, columns, { direction: "desc", key: "amount" })
    expect(descending.map((entry) => entry.row.name)).toEqual(["乙项目", "甲项目", "丙项目"])
  })

  it("文本列按 zh-CN 拼音排序，同值行保持原序", () => {
    // zh-CN 按拼音：bei < nan，所以北区在前；两条北区行保持 0、2 的原始次序。
    const sorted = sortDatatableEntries(entries, columns, { direction: "asc", key: "team" })
    expect(sorted.map((entry) => entry.index)).toEqual([0, 2, 1])
  })

  it("搜索匹配显示文本与原值，且大小写无关", () => {
    expect(
      filterDatatableEntries(entries, columns, "甲").map((entry) => entry.row.name)
    ).toEqual(["甲项目"])
    // 1200 的显示文本是 ¥1,200.00，带分隔符也要能搜到。
    expect(filterDatatableEntries(entries, columns, "1,200")).toHaveLength(1)
    expect(filterDatatableEntries(entries, columns, "1200")).toHaveLength(1)
    expect(filterDatatableEntries(entries, columns, "  ")).toHaveLength(3)
    expect(filterDatatableEntries(entries, columns, "没有")).toHaveLength(0)
  })

  it("分组保持传入顺序，空 key 返回 null", () => {
    const groups = groupDatatableEntries(entries, columns, "team")
    expect(groups?.map((group) => [group.value, group.entries.length])).toEqual([
      ["北区", 2],
      ["南区", 1],
    ])
    expect(groupDatatableEntries(entries, columns, null)).toBeNull()
  })
})

describe("数据表格式化与写回", () => {
  it("按 zh-CN 格式化各列类型", () => {
    expect(formatDatatableCell(1200, "currency")).toBe("¥1,200.00")
    expect(formatDatatableCell(0.128, "percent")).toBe("12.8%")
    expect(formatDatatableCell(1234567, "number")).toBe("1,234,567")
    expect(formatDatatableCell(true, "boolean")).toBe("是")
    expect(formatDatatableCell(false, "boolean")).toBe("否")
    expect(formatDatatableCell("2026-09-21", "date")).toBe("2026年9月21日")
    expect(formatDatatableCell(null)).toBe("—")
    expect(formatDatatableCell("", "text")).toBe("—")
    expect(formatDatatableCell("自由文本")).toBe("自由文本")
  })

  it("输入框文本按列类型收敛", () => {
    expect(coerceDatatableValue("12", "number")).toBe(12)
    expect(coerceDatatableValue("abc", "number")).toBe("abc")
    expect(coerceDatatableValue("是", "boolean")).toBe(true)
    expect(coerceDatatableValue("  ", "text")).toBe("")
    expect(coerceDatatableValue("甲", "text")).toBe("甲")
  })

  it("写回单元格只动 rows，视图状态原样保留", () => {
    const withView: DatatableSpec = { ...spec, view: { sort: { direction: "asc", key: "name" } } }
    const next = setDatatableCell(withView, 1, "name", "甲甲")
    expect(next.rows[1].name).toBe("甲甲")
    expect(next.rows[0]).toBe(withView.rows[0])
    expect(next.view).toEqual(withView.view)
    expect(setDatatableCell(withView, 9, "name", "越界")).toBe(withView)
  })

  it("保存视图写入非空字段，空视图删掉该字段", () => {
    const saved = writeDatatableView(spec, { filter: "甲", group: "team" })
    expect(saved.view).toEqual({ filter: "甲", group: "team" })
    expect(writeDatatableView(saved, {}).view).toBeUndefined()
  })

  it("导出 CSV 用显示文本，并按 CSV 规则转义", () => {
    const csv = datatableToCsv(columns.slice(0, 2), toDatatableEntries(spec.rows))
    expect(csv).toBe(
      '名称,金额\r\n乙项目,"¥1,200.00"\r\n甲项目,¥300.00\r\n丙项目,\r\n'
    )
  })

  it("CSV 表头与记录能转成列定义与行", () => {
    const csvColumns = datatableColumnsFromCsv(["姓名", "  "])
    expect(csvColumns).toEqual([
      { key: "c0", label: "姓名" },
      { key: "c1", label: "列 2" },
    ])
    expect(datatableRowsFromCsv([["张三"]], csvColumns)).toEqual([{ c0: "张三", c1: "" }])
  })
})

describe("数据表增删行列", () => {
  const base = parseDatatableSource(
    JSON.stringify({
      columns: [
        { key: "column1", label: "列 1", type: "text" },
        { key: "column2", label: "列 2", type: "text" },
      ],
      rows: [{ column1: "甲", column2: "乙" }],
      view: { sort: { key: "column2", direction: "asc" }, group: "column1" },
    })
  )
  if (isDatatableParseError(base)) throw new Error(base.error)

  it("加行补齐所有列的空串，删行按原始下标", () => {
    const added = addDatatableRow(base)
    expect(added.rows).toEqual([{ column1: "甲", column2: "乙" }, { column1: "", column2: "" }])
    expect(removeDatatableRow(added, 0).rows).toEqual([{ column1: "", column2: "" }])
    expect(removeDatatableRow(added, 5)).toBe(added)
  })

  it("加列取未占用的 key，已有行补空串", () => {
    const { key, spec } = addDatatableColumn(base)
    expect(key).toBe("column3")
    expect(spec.columns[spec.columns.length - 1]).toEqual({ key: "column3", label: "列 3", type: "text" })
    expect(spec.rows[0]).toEqual({ column1: "甲", column2: "乙", column3: "" })
    const removed = removeDatatableColumn(spec, "column1")
    expect(addDatatableColumn(removed).key).toBe("column4")
  })

  it("改列名只动 label，空名与同名不产生新对象", () => {
    const renamed = renameDatatableColumn(base, "column1", "  名称 ")
    expect(renamed.columns[0]).toEqual({ key: "column1", label: "名称", type: "text" })
    expect(renameDatatableColumn(base, "column1", "  ")).toBe(base)
    expect(renameDatatableColumn(base, "column1", "列 1")).toBe(base)
  })

  it("删列连带删字段与引用它的视图，最后一列不删", () => {
    const removed = removeDatatableColumn(base, "column2")
    expect(removed.columns.map((column) => column.key)).toEqual(["column1"])
    expect(removed.rows).toEqual([{ column1: "甲" }])
    expect(removed.view).toEqual({ group: "column1" })
    expect(removeDatatableColumn(removed, "column1")).toBe(removed)
  })
})
