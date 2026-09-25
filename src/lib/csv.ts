export type CsvEncoding = "gbk" | "utf-16be" | "utf-16le" | "utf-8" | "utf-8-bom"

export interface CsvDocument {
  encoding: CsvEncoding
  records: string[][]
}

export type CsvWorkerRequest = {
  bytes: Uint8Array
  requestId: string
  type: "parse"
}

export type CsvWorkerResponse =
  | { document: CsvDocument; requestId: string; type: "parsed" }
  | { error: string; requestId: string; type: "error" }

export function parseCsv(source: string): string[][] {
  const text = source.replace(/^\uFEFF/u, "")
  if (text.length === 0) return []

  const records: string[][] = []
  let record: string[] = []
  let field = ""
  let inQuotedField = false
  let closedQuotedField = false
  let endedWithRecordBreak = false

  const finishField = () => {
    record.push(field)
    field = ""
    closedQuotedField = false
  }
  const finishRecord = () => {
    finishField()
    records.push(record)
    record = []
    endedWithRecordBreak = true
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]

    if (inQuotedField) {
      if (character !== '"') {
        field += character
        continue
      }
      if (text[index + 1] === '"') {
        field += '"'
        index += 1
      } else {
        inQuotedField = false
        closedQuotedField = true
      }
      continue
    }

    if (closedQuotedField && character !== "," && character !== "\r" && character !== "\n") {
      throw new Error(`CSV 第 ${index + 1} 个字符：结束引号后只能是逗号或换行`)
    }

    if (character === '"') {
      if (field.length > 0) {
        throw new Error(`CSV 第 ${index + 1} 个字符：未加引号字段中不能出现引号`)
      }
      inQuotedField = true
      endedWithRecordBreak = false
      continue
    }
    if (character === ",") {
      finishField()
      endedWithRecordBreak = false
      continue
    }
    if (character === "\r" || character === "\n") {
      if (character === "\r" && text[index + 1] === "\n") index += 1
      finishRecord()
      continue
    }

    field += character
    endedWithRecordBreak = false
  }

  if (inQuotedField) throw new Error("CSV 存在未闭合的引号字段")
  if (!endedWithRecordBreak || record.length > 0 || field.length > 0) {
    finishRecord()
  }

  return records
}

/**
 * CSV 序列化：`parseCsv` 的逆运算。字段含引号、逗号或换行时加引号并把引号翻倍，
 * 记录之间用 CRLF（RFC 4180）——与 `exportTableCsv` 的写法一致，
 * 但这里只处理纯字符串矩阵，不掺多维表格的字段类型与公式防护。
 */
export function serializeCsv(records: readonly (readonly string[])[]): string {
  return records.map((record) => record.map(serializeCsvField).join(",")).join("\r\n")
}

function serializeCsvField(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value
}

export function decodeCsvBytes(bytes: Uint8Array): { encoding: CsvEncoding; text: string } {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    return {
      encoding: "utf-8-bom",
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(3)),
    }
  }
  if (startsWith(bytes, [0xff, 0xfe])) {
    return {
      encoding: "utf-16le",
      text: new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2)),
    }
  }
  if (startsWith(bytes, [0xfe, 0xff])) {
    return {
      encoding: "utf-16be",
      text: new TextDecoder("utf-16be", { fatal: true }).decode(bytes.subarray(2)),
    }
  }

  try {
    return {
      encoding: "utf-8",
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    }
  } catch {
    return {
      encoding: "gbk",
      text: new TextDecoder("gbk", { fatal: true }).decode(bytes),
    }
  }
}

export function parseCsvBytes(bytes: Uint8Array): CsvDocument {
  const decoded = decodeCsvBytes(bytes)
  return { encoding: decoded.encoding, records: parseCsv(decoded.text) }
}

export function isNonUtf8CsvEncoding(encoding: CsvEncoding) {
  return encoding !== "utf-8" && encoding !== "utf-8-bom"
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]) {
  return prefix.every((value, index) => bytes[index] === value)
}
