//! Bounded XLSX exchange. Call from a blocking worker; no vault access or writes.
//! Preview values include source issues; callers must resolve errors before creating a table.
use super::model::{CellValue, FieldType, TableError, TableLimits, TableResult};
use calamine::{DataRef, Reader, Xlsx, XlsxFormulaMetadata};
use chrono::{Datelike, NaiveDate};
use quick_xml::{events::Event, Reader as XmlReader};
use rust_xlsxwriter::{ExcelDateTime, Format, Workbook};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::{Cursor, Read, Write},
    path::Path,
};

#[derive(Debug, Clone)]
pub struct XlsxLimits {
    pub table: TableLimits,
    pub max_import_bytes: usize,
    pub max_uncompressed_bytes: usize,
    pub max_zip_entries: usize,
    pub max_sheets: usize,
    pub max_styles: usize,
    pub max_xml_depth: usize,
    pub max_xml_events: usize,
}
impl Default for XlsxLimits {
    fn default() -> Self {
        let table = TableLimits::default();
        Self {
            max_import_bytes: table.max_file_bytes,
            max_uncompressed_bytes: table.max_file_bytes,
            max_zip_entries: 1024,
            max_sheets: 32,
            max_styles: 4096,
            max_xml_depth: 64,
            max_xml_events: table.max_cells * 16,
            table,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct XlsxIssue {
    pub code: String,
    pub message: String,
    pub severity: String,
    pub row: Option<u32>,
    pub column: Option<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct XlsxCell {
    pub value: CellValue,
    pub kind: String,
    pub raw_text: Option<String>,
    pub formula: Option<String>,
    pub issues: Vec<XlsxIssue>,
}
impl Default for XlsxCell {
    fn default() -> Self {
        Self {
            value: CellValue::Null,
            kind: "empty".into(),
            raw_text: None,
            formula: None,
            issues: vec![],
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxWorkbookInfo {
    pub sheet_names: Vec<String>,
    pub issues: Vec<XlsxIssue>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxPreview {
    pub sheet_names: Vec<String>,
    pub sheet_index: usize,
    pub rows: Vec<Vec<XlsxCell>>,
    pub total_rows: usize,
    pub total_columns: usize,
    pub truncated: bool,
    pub issues: Vec<XlsxIssue>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct XlsxExportColumn {
    pub name: String,
    pub kind: FieldType,
}

fn invalid(message: impl Into<String>) -> TableError {
    TableError::new("INVALID_VALUE", message, "")
}
fn limit(message: impl Into<String>) -> TableError {
    TableError::new("LIMIT_EXCEEDED", message, "")
}
fn issue(code: &str, message: &str, severity: &str, pos: Option<(u32, u32)>) -> XlsxIssue {
    XlsxIssue {
        code: code.into(),
        message: message.into(),
        severity: severity.into(),
        row: pos.map(|p| p.0),
        column: pos.map(|p| p.1),
    }
}

pub fn read_xlsx_file(path: &Path, limits: &XlsxLimits) -> TableResult<Vec<u8>> {
    let file = File::open(path).map_err(|e| TableError::new("IO_ERROR", e.to_string(), ""))?;
    let mut bytes = Vec::new();
    file.take(limits.max_import_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| TableError::new("IO_ERROR", e.to_string(), ""))?;
    if bytes.len() > limits.max_import_bytes {
        return Err(limit("XLSX 文件超过导入字节上限"));
    }
    Ok(bytes)
}

#[derive(Default)]
struct RawCell {
    pos: (u32, u32),
    raw: String,
    has_value: bool,
    cell_type: String,
    style: usize,
    formula: bool,
    shared: Option<usize>,
}
#[derive(Default)]
struct RawSheet {
    cells: BTreeMap<(u32, u32), RawCell>,
    rows: usize,
    columns: usize,
    issues: Vec<XlsxIssue>,
}
#[derive(Default)]
struct Preflight {
    sheets: Vec<(String, String)>,
    relations: BTreeMap<String, String>,
    worksheets: BTreeMap<String, RawSheet>,
    formats: BTreeMap<usize, String>,
    styles: Vec<usize>,
    issues: Vec<XlsxIssue>,
    strings: usize,
}
fn attr(attrs: &BTreeMap<String, String>, key: &str) -> TableResult<usize> {
    attrs.get(key).map_or(Ok(0), |v| {
        v.parse()
            .map_err(|_| invalid(format!("无效 XLSX 整数属性 {key}")))
    })
}
fn position(address: &str, limits: &XlsxLimits) -> TableResult<(u32, u32)> {
    let mut col = 0usize;
    let mut split = 0;
    for b in address.bytes() {
        if !b.is_ascii_uppercase() {
            break;
        }
        col = col
            .checked_mul(26)
            .and_then(|v| v.checked_add((b - b'A' + 1) as usize))
            .ok_or_else(|| limit("XLSX 列坐标溢出"))?;
        split += 1;
    }
    let row: usize = address[split..]
        .parse()
        .map_err(|_| invalid("XLSX 单元格坐标无效"))?;
    if col == 0 || row == 0 {
        return Err(invalid("XLSX 单元格坐标无效"));
    }
    if row > limits.table.max_rows + 1 || col > limits.table.max_fields {
        return Err(limit("XLSX 单元格坐标超出表格行列上限"));
    }
    Ok(((row - 1) as u32, (col - 1) as u32))
}
fn dimension(range: &str, limits: &XlsxLimits) -> TableResult<()> {
    for part in range.split(':') {
        position(part, limits)?;
    }
    Ok(())
}
fn safe_member(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('/')
        && !name.contains('\\')
        && !name.contains(':')
        && name
            .trim_end_matches('/')
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
}
fn worksheet_path(target: &str) -> TableResult<String> {
    let path = if target.starts_with('/') {
        target.trim_start_matches('/').to_string()
    } else {
        format!("xl/{target}")
    };
    if !safe_member(&path) {
        return Err(invalid("工作表关系路径不受支持"));
    }
    Ok(path)
}

// Bound central-directory allocation before ZipArchive reads it. ZIP64 is unnecessary
// for this module's file budget and is explicitly unsupported rather than guessed.
fn precheck_directory(bytes: &[u8], limits: &XlsxLimits) -> TableResult<()> {
    if bytes.len() > limits.max_import_bytes {
        return Err(limit("XLSX 文件超过导入字节上限"));
    }
    let start = bytes.len().saturating_sub(65_557);
    let end = (start..bytes.len().saturating_sub(21))
        .rev()
        .find(|&i| bytes.get(i..i + 4) == Some(b"PK\x05\x06"))
        .ok_or_else(|| invalid("XLSX ZIP 中央目录缺失"))?;
    let u16at =
        |offset| u16::from_le_bytes([bytes[end + offset], bytes[end + offset + 1]]) as usize;
    let count = u16at(10);
    if u16at(4) != 0 || u16at(6) != 0 || u16at(8) != count {
        return Err(invalid("不支持分卷 XLSX"));
    }
    if count == u16::MAX as usize
        || bytes.get(end.saturating_sub(20)..end.saturating_sub(16)) == Some(b"PK\x06\x07")
    {
        return Err(invalid("不支持 ZIP64 XLSX"));
    }
    if count > limits.max_zip_entries {
        return Err(limit("XLSX ZIP 成员过多"));
    }
    if end + 22 + u16at(20) != bytes.len() {
        return Err(invalid("XLSX ZIP 末尾结构无效"));
    }
    let u32at = |offset| {
        u32::from_le_bytes(bytes[end + offset..end + offset + 4].try_into().unwrap()) as usize
    };
    let mut offset = u32at(16);
    let directory_size = u32at(12);
    if offset.checked_add(directory_size) != Some(end) || !bytes.starts_with(b"PK\x03\x04") {
        return Err(invalid("XLSX ZIP 中央目录边界无效"));
    }
    let mut names = BTreeSet::new();
    let mut declared = 0usize;
    for _ in 0..count {
        if offset + 46 > end || bytes.get(offset..offset + 4) != Some(b"PK\x01\x02") {
            return Err(invalid("XLSX ZIP 中央目录成员无效"));
        }
        let read16 = |at| u16::from_le_bytes([bytes[offset + at], bytes[offset + at + 1]]) as usize;
        if read16(8) & 0x41 != 0 {
            return Err(invalid("不支持加密 XLSX"));
        }
        if read16(34) != 0 {
            return Err(invalid("不支持分卷 XLSX"));
        }
        let size = u32::from_le_bytes(bytes[offset + 24..offset + 28].try_into().unwrap()) as usize;
        if size == u32::MAX as usize {
            return Err(invalid("不支持 ZIP64 XLSX"));
        }
        declared = declared
            .checked_add(size)
            .ok_or_else(|| limit("XLSX 展开大小溢出"))?;
        if declared > limits.max_uncompressed_bytes {
            return Err(limit("XLSX 声明展开大小超过上限"));
        }
        let name_len = read16(28);
        let next = offset + 46 + name_len + read16(30) + read16(32);
        if next > end {
            return Err(invalid("XLSX ZIP 成员名称边界无效"));
        }
        let name = std::str::from_utf8(&bytes[offset + 46..offset + 46 + name_len])
            .map_err(|_| invalid("XLSX ZIP 成员名不是 UTF-8"))?;
        if !safe_member(name) || !names.insert(name.to_string()) {
            return Err(invalid("XLSX ZIP 含无效或重复成员路径"));
        }
        offset = next;
    }
    if offset != end {
        return Err(invalid("XLSX ZIP 成员数量与中央目录不一致"));
    }
    Ok(())
}
fn preflight(bytes: &[u8], limits: &XlsxLimits) -> TableResult<Preflight> {
    precheck_directory(bytes, limits)?;
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| invalid(format!("XLSX ZIP 无法读取：{e}")))?;
    if zip.len() > limits.max_zip_entries {
        return Err(limit("XLSX ZIP 成员过多"));
    }
    let mut names = BTreeSet::new();
    let mut expanded = 0usize;
    let mut xml_events = 0usize;
    let mut result = Preflight::default();
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|e| invalid(format!("XLSX ZIP 成员无法读取：{e}")))?;
        let name = entry.name().to_string();
        if !safe_member(&name) || !names.insert(name.clone()) {
            return Err(invalid("XLSX ZIP 含无效或重复成员路径"));
        }
        if entry.encrypted() {
            return Err(invalid("不支持加密 XLSX"));
        }
        if !matches!(
            entry.compression(),
            zip::CompressionMethod::Stored | zip::CompressionMethod::Deflated
        ) {
            return Err(invalid("不支持此 XLSX 压缩方式"));
        }
        let remaining = limits.max_uncompressed_bytes.saturating_sub(expanded);
        if entry.size() > remaining as u64 {
            return Err(limit("XLSX 声明展开大小超过上限"));
        }
        let mut data = Vec::new();
        (&mut entry)
            .take(remaining as u64 + 1)
            .read_to_end(&mut data)
            .map_err(|e| invalid(format!("XLSX 展开失败：{e}")))?;
        if data.len() > remaining {
            return Err(limit("XLSX 实际展开大小超过上限"));
        }
        expanded += data.len();
        if name.ends_with(".xml") || name.ends_with(".rels") {
            scan_xml(&name, &data, &mut result, limits, &mut xml_events)?;
        } else if name.ends_with("vbaProject.bin") {
            result.issues.push(issue(
                "MACROS_IGNORED",
                "工作簿含宏；不会执行或导入宏",
                "warning",
                None,
            ));
        }
    }
    if !names.contains("[Content_Types].xml") || !names.contains("xl/workbook.xml") {
        return Err(invalid("不是受支持的 XLSX 工作簿"));
    }
    if result.sheets.is_empty() {
        return Err(invalid("XLSX 没有工作表"));
    }
    for (_, id) in &result.sheets {
        let path = worksheet_path(
            result
                .relations
                .get(id)
                .ok_or_else(|| invalid("工作表关系缺失"))?,
        )?;
        if !result.worksheets.contains_key(&path) {
            return Err(invalid("工作表内容未通过 XML 预检"));
        }
    }
    let total_cells: usize = result.worksheets.values().map(|s| s.cells.len()).sum();
    if total_cells > limits.table.max_cells + limits.table.max_fields {
        return Err(limit("XLSX 工作簿实际单元格总数超过上限"));
    }
    for sheet in result.worksheets.values() {
        for cell in sheet.cells.values() {
            if cell.style >= result.styles.len() && cell.style != 0 {
                return Err(invalid("单元格引用不存在的样式"));
            }
            if cell.cell_type == "s"
                && cell
                    .raw
                    .parse::<usize>()
                    .map_or(true, |i| i >= result.strings)
            {
                return Err(invalid("单元格引用不存在的共享字符串"));
            }
        }
    }
    Ok(result)
}

fn scan_xml(
    name: &str,
    bytes: &[u8],
    result: &mut Preflight,
    limits: &XlsxLimits,
    events: &mut usize,
) -> TableResult<()> {
    let text = std::str::from_utf8(bytes).map_err(|_| invalid("XLSX XML 必须为 UTF-8"))?;
    let mut reader = XmlReader::from_str(text);
    reader.config_mut().expand_empty_elements = true;
    let mut stack = Vec::<String>::new();
    let mut sheet = RawSheet::default();
    let mut cell = None::<RawCell>;
    let mut shared_chars = 0usize;
    let mut cell_chars = 0usize;
    let mut root = String::new();
    let mut roots = 0;
    loop {
        *events += 1;
        if *events > limits.max_xml_events {
            return Err(limit("XLSX XML 事件数量超过上限"));
        }
        match reader
            .read_event()
            .map_err(|e| invalid(format!("XLSX XML 无效：{e}")))?
        {
            Event::Start(e) => {
                let tag = String::from_utf8_lossy(e.local_name().as_ref()).to_string();
                if stack.is_empty() {
                    roots += 1;
                    root = tag.clone();
                    if roots > 1 {
                        return Err(invalid("XLSX XML 含多个根节点"));
                    }
                }
                stack.push(tag.clone());
                if stack.len() > limits.max_xml_depth {
                    return Err(limit("XLSX XML 嵌套过深"));
                }
                let mut attrs = BTreeMap::new();
                for a in e.attributes() {
                    let a = a.map_err(|_| invalid("XLSX XML 属性重复或无效"))?;
                    let key = String::from_utf8_lossy(a.key.as_ref()).to_string();
                    let value = a
                        .decoded_and_normalized_value(
                            quick_xml::XmlVersion::Implicit1_0,
                            reader.decoder(),
                        )
                        .map_err(|_| invalid("XLSX XML 属性编码无效"))?
                        .into_owned();
                    if value.chars().count() > limits.table.max_text_chars {
                        return Err(limit("XLSX XML 属性过长"));
                    }
                    attrs.insert(key, value);
                }
                if tag == "sst" {
                    if attr(&attrs, "uniqueCount")? > limits.table.max_cells {
                        return Err(limit("XLSX sharedStrings uniqueCount 超过上限"));
                    }
                    if attr(&attrs, "count")? > limits.table.max_cells * limits.max_sheets {
                        return Err(limit("XLSX sharedStrings count 超过上限"));
                    }
                }
                if root == "sst" && tag == "si" {
                    result.strings += 1;
                    shared_chars = 0;
                    if result.strings > limits.table.max_cells {
                        return Err(limit("XLSX 共享字符串过多"));
                    }
                }
                if name == "xl/workbook.xml" && tag == "sheet" {
                    if result.sheets.len() >= limits.max_sheets {
                        return Err(limit("XLSX 工作表过多"));
                    }
                    let title = attrs
                        .get("name")
                        .ok_or_else(|| invalid("工作表名称缺失"))?
                        .clone();
                    let id = attrs
                        .get("r:id")
                        .ok_or_else(|| invalid("工作表关系 ID 缺失"))?
                        .clone();
                    if result.sheets.iter().any(|(n, i)| n == &title || i == &id) {
                        return Err(invalid("工作表名称或关系重复"));
                    }
                    if attrs.get("state").is_some_and(|v| v != "visible") {
                        result.issues.push(issue(
                            "HIDDEN_SHEET",
                            "工作簿包含隐藏工作表；请选择需要导入的工作表",
                            "warning",
                            None,
                        ));
                    }
                    result.sheets.push((title, id));
                }
                if tag == "Relationship" {
                    if attrs.get("TargetMode").is_some_and(|v| v == "External") {
                        result.issues.push(issue(
                            "EXTERNAL_LINK_IGNORED",
                            "工作簿含外部关系；不会访问网络或更新外链",
                            "warning",
                            None,
                        ));
                    }
                    if name == "xl/_rels/workbook.xml.rels"
                        && attrs.get("Type").is_some_and(|v| v.ends_with("/worksheet"))
                    {
                        if attrs.get("TargetMode").is_some_and(|v| v == "External") {
                            return Err(invalid("不支持外部工作表"));
                        }
                        let id = attrs
                            .get("Id")
                            .ok_or_else(|| invalid("工作表关系 ID 缺失"))?
                            .clone();
                        let target = attrs
                            .get("Target")
                            .ok_or_else(|| invalid("工作表目标缺失"))?
                            .clone();
                        if result.relations.insert(id, target).is_some() {
                            return Err(invalid("重复工作表关系"));
                        }
                    }
                }
                if name == "xl/styles.xml" {
                    if tag == "numFmt" {
                        result.formats.insert(
                            attr(&attrs, "numFmtId")?,
                            attrs.get("formatCode").cloned().unwrap_or_default(),
                        );
                    }
                    if tag == "xf"
                        && stack
                            .get(stack.len().saturating_sub(2))
                            .is_some_and(|t| t == "cellXfs")
                    {
                        if result.styles.len() >= limits.max_styles {
                            return Err(limit("XLSX 样式过多"));
                        }
                        result.styles.push(attr(&attrs, "numFmtId")?);
                    }
                    if attrs.contains_key("count") && attr(&attrs, "count")? > limits.max_styles {
                        return Err(limit("XLSX 样式声明数量超过上限"));
                    }
                    if result.formats.len() > limits.max_styles {
                        return Err(limit("XLSX 数字格式过多"));
                    }
                }
                if root == "worksheet" {
                    if tag == "row" {
                        if let Some(r) = attrs.get("r") {
                            position(&format!("A{r}"), limits)?;
                        }
                    }
                    if tag == "col" && attr(&attrs, "max")? > limits.table.max_fields {
                        return Err(limit("XLSX 列格式超出列数上限"));
                    }
                    if (tag == "row" || tag == "col")
                        && attrs.get("hidden").is_some_and(|v| v == "1" || v == "true")
                        && !sheet
                            .issues
                            .iter()
                            .any(|i| i.code == "HIDDEN_ROWS_OR_COLUMNS")
                    {
                        sheet.issues.push(issue(
                            "HIDDEN_ROWS_OR_COLUMNS",
                            "隐藏行列仍在预览中保留",
                            "warning",
                            None,
                        ));
                    }
                    if tag == "dimension" {
                        if let Some(r) = attrs.get("ref") {
                            dimension(r, limits)?;
                        }
                    }
                    if tag == "mergeCell" {
                        let r = attrs.get("ref").ok_or_else(|| invalid("合并范围缺失"))?;
                        dimension(r, limits)?;
                        if sheet.issues.len() > limits.table.max_cells {
                            return Err(limit("合并范围过多"));
                        }
                        sheet.issues.push(issue(
                            "MERGED_CELLS",
                            &format!("合并区域 {r}：仅保留实际单元格值，不填充其他格"),
                            "warning",
                            None,
                        ));
                    }
                    if tag == "c" {
                        if cell.is_some() {
                            return Err(invalid("XLSX 单元格嵌套无效"));
                        }
                        let pos = position(
                            attrs
                                .get("r")
                                .ok_or_else(|| invalid("XLSX 单元格坐标缺失"))?,
                            limits,
                        )?;
                        let style = attr(&attrs, "s")?;
                        if style >= limits.max_styles {
                            return Err(limit("XLSX 样式索引超过上限"));
                        }
                        cell = Some(RawCell {
                            pos,
                            style,
                            cell_type: attrs.get("t").cloned().unwrap_or_default(),
                            ..Default::default()
                        });
                        cell_chars = 0;
                    }
                    if tag == "v" {
                        if let Some(c) = &mut cell {
                            c.has_value = true;
                        }
                    }
                    if tag == "f" {
                        if let Some(c) = &mut cell {
                            c.formula = true;
                            if attrs.contains_key("si") {
                                let si = attr(&attrs, "si")?;
                                if si >= limits.table.max_cells {
                                    return Err(limit("共享公式索引超过上限"));
                                }
                                c.shared = Some(si);
                            }
                        }
                        if let Some(r) = attrs.get("ref") {
                            dimension(r, limits)?;
                        }
                    }
                }
            }
            Event::End(_) => {
                let tag = stack
                    .pop()
                    .ok_or_else(|| invalid("XLSX XML 结束节点无效"))?;
                if root == "worksheet" && tag == "c" {
                    let c = cell
                        .take()
                        .ok_or_else(|| invalid("XLSX 单元格结束位置无效"))?;
                    sheet.rows = sheet.rows.max(c.pos.0 as usize + 1);
                    sheet.columns = sheet.columns.max(c.pos.1 as usize + 1);
                    if sheet.rows.saturating_sub(1).max(1) * sheet.columns > limits.table.max_cells
                    {
                        return Err(limit("XLSX 矩形单元格数量超过上限"));
                    }
                    if sheet.cells.insert(c.pos, c).is_some() {
                        return Err(invalid("XLSX 含重复单元格坐标"));
                    }
                }
            }
            Event::Text(e) => {
                let s = e
                    .xml10_content()
                    .map_err(|_| invalid("XLSX XML 文本编码无效"))?;
                count_xml_text(
                    &s,
                    &root,
                    &stack,
                    &mut cell,
                    &mut cell_chars,
                    &mut shared_chars,
                    limits,
                )?;
            }
            Event::CData(e) => {
                let s = e.decode().map_err(|_| invalid("XLSX CDATA 编码无效"))?;
                count_xml_text(
                    &s,
                    &root,
                    &stack,
                    &mut cell,
                    &mut cell_chars,
                    &mut shared_chars,
                    limits,
                )?;
            }
            Event::GeneralRef(e) => {
                let reference = e.decode().map_err(|_| invalid("XLSX XML 实体编码无效"))?;
                let escaped = format!("&{reference};");
                let s = quick_xml::escape::unescape(&escaped)
                    .map_err(|_| invalid("不支持 XLSX XML 自定义实体"))?;
                count_xml_text(
                    &s,
                    &root,
                    &stack,
                    &mut cell,
                    &mut cell_chars,
                    &mut shared_chars,
                    limits,
                )?;
            }
            Event::DocType(_) => return Err(invalid("不支持 XLSX XML DTD")),
            Event::Eof => break,
            _ => {}
        }
    }
    if !stack.is_empty() || roots != 1 {
        return Err(invalid("XLSX XML 截断或为空"));
    }
    if root == "worksheet" {
        result.worksheets.insert(name.into(), sheet);
    }
    Ok(())
}
fn count_xml_text(
    text: &str,
    root: &str,
    stack: &[String],
    cell: &mut Option<RawCell>,
    cell_chars: &mut usize,
    shared_chars: &mut usize,
    limits: &XlsxLimits,
) -> TableResult<()> {
    if root == "sst" && stack.iter().any(|t| t == "si") {
        *shared_chars += text.chars().count();
        if *shared_chars > limits.table.max_text_chars {
            return Err(limit("XLSX 共享字符串过长"));
        }
    }
    if let Some(c) = cell {
        *cell_chars += text.chars().count();
        if *cell_chars > limits.table.max_text_chars {
            return Err(limit("XLSX 单元格文本或公式过长"));
        }
        if stack.last().is_some_and(|t| t == "v") {
            c.raw.push_str(text);
        }
    }
    Ok(())
}

pub fn inspect_xlsx(bytes: &[u8], limits: &XlsxLimits) -> TableResult<XlsxWorkbookInfo> {
    let checked = preflight(bytes, limits)?;
    // Construction happens only after all XML has passed allocation/coordinate checks.
    let workbook =
        Xlsx::new(Cursor::new(bytes)).map_err(|e| invalid(format!("解析 XLSX 失败：{e}")))?;
    Ok(XlsxWorkbookInfo {
        sheet_names: workbook.sheet_names(),
        issues: checked.issues,
    })
}

pub fn preview_xlsx(
    bytes: &[u8],
    sheet_index: usize,
    max_preview_rows: usize,
    limits: &XlsxLimits,
) -> TableResult<XlsxPreview> {
    let checked = preflight(bytes, limits)?;
    let mut workbook =
        Xlsx::new(Cursor::new(bytes)).map_err(|e| invalid(format!("解析 XLSX 失败：{e}")))?;
    let names = workbook.sheet_names();
    let name = names
        .get(sheet_index)
        .ok_or_else(|| invalid("选择的工作表不存在"))?;
    let (_, id) = checked
        .sheets
        .iter()
        .find(|(n, _)| n == name)
        .ok_or_else(|| invalid("工作表未通过预检"))?;
    let path = worksheet_path(&checked.relations[id])?;
    let raw = &checked.worksheets[&path];
    let mut rows = vec![vec![XlsxCell::default(); raw.columns]; raw.rows.min(max_preview_rows)];
    let mut issues = checked.issues.clone();
    issues.extend(raw.issues.clone());
    let mut reader = workbook
        .worksheet_cells_reader(name)
        .map_err(|e| invalid(format!("读取工作表失败：{e}")))?;
    while let Some(record) = reader
        .next_cell_with_formula_metadata()
        .map_err(|e| invalid(format!("读取单元格失败：{e}")))?
    {
        let pos = record.pos;
        let source = raw
            .cells
            .get(&pos)
            .ok_or_else(|| invalid("单元格未通过预检"))?;
        let mut cell = convert_cell(record.value, source, &checked, limits)?;
        if let Some(formula) = record.formula {
            cell.formula = match formula {
                XlsxFormulaMetadata::Normal { formula }
                | XlsxFormulaMetadata::Shared { formula, .. } => Some(formula),
                XlsxFormulaMetadata::SharedDerived { .. } => {
                    cell.issues.push(issue(
                        "SHARED_FORMULA_TEXT_UNAVAILABLE",
                        "共享公式使用缓存预览，首版不展开派生公式文本",
                        "warning",
                        Some(pos),
                    ));
                    None
                }
                _ => return Err(invalid("不支持的 XLSX 公式类型")),
            };
            cell.issues.push(issue(
                "FORMULA_CACHED_VALUE",
                "该值来自公式缓存；未重算且无法验证缓存是否最新",
                "warning",
                Some(pos),
            ));
            if !source.has_value || (source.raw.is_empty() && source.cell_type != "str") {
                cell.value = CellValue::Null;
                cell.kind = "error".into();
                cell.issues.push(issue(
                    "FORMULA_CACHE_MISSING",
                    "公式没有缓存值，不能当作空单元格导入",
                    "error",
                    Some(pos),
                ));
            }
        }
        issues.extend(cell.issues.clone());
        if let Some(row) = rows.get_mut(pos.0 as usize) {
            row[pos.1 as usize] = cell;
        }
    }
    Ok(XlsxPreview {
        sheet_names: names,
        sheet_index,
        rows,
        total_rows: raw.rows,
        total_columns: raw.columns,
        truncated: raw.rows > max_preview_rows,
        issues,
    })
}
fn convert_cell(
    value: DataRef<'_>,
    source: &RawCell,
    checked: &Preflight,
    limits: &XlsxLimits,
) -> TableResult<XlsxCell> {
    let mut cell = XlsxCell {
        raw_text: source.has_value.then(|| source.raw.clone()),
        ..Default::default()
    };
    let pos = Some(source.pos);
    match value {
        DataRef::Empty => {}
        DataRef::String(v) => {
            cell.kind = "text".into();
            cell.value = CellValue::Text(v);
        }
        DataRef::SharedString(v) => {
            cell.kind = "text".into();
            cell.value = CellValue::Text(v.into());
        }
        DataRef::Bool(v) => {
            cell.kind = "checkbox".into();
            cell.value = CellValue::Checkbox(v);
        }
        DataRef::Int(v) => set_number(v as f64, source, checked, &mut cell),
        DataRef::Float(v) => set_number(v, source, checked, &mut cell),
        DataRef::DateTime(v) => {
            if !v.as_f64().is_finite() || v.as_f64() < 0.0 || v.as_f64() > 2_958_465.0 {
                cell.kind = "error".into();
                cell.issues.push(issue(
                    "INVALID_EXCEL_DATE",
                    "Excel 日期序列超出可用范围",
                    "error",
                    pos,
                ));
                return Ok(cell);
            }
            let (year, month, day, hour, minute, second, milli) = v.to_ymd_hms_milli();
            if v.is_duration()
                || v.as_f64().fract() != 0.0
                || hour != 0
                || minute != 0
                || second != 0
                || milli != 0
            {
                cell.kind = "error".into();
                cell.issues.push(issue(
                    "DATE_TIME_OR_DURATION",
                    "日期时间、时间或时长不能静默截成日期；请显式选择文本",
                    "error",
                    pos,
                ));
            } else if let Some(date) =
                NaiveDate::from_ymd_opt(year as i32, month as u32, day as u32)
                    .filter(|d| d.year() >= 1 && d.year() <= 9999)
            {
                cell.kind = "date".into();
                cell.value = CellValue::Text(date.format("%Y-%m-%d").to_string());
            } else {
                cell.kind = "error".into();
                cell.issues.push(issue(
                    "INVALID_EXCEL_DATE",
                    "无效 Excel 日期（含虚构的 1900-02-29），不能静默修正",
                    "error",
                    pos,
                ));
            }
        }
        DataRef::DateTimeIso(v) => {
            if valid_date(&v).is_some() {
                cell.kind = "date".into();
                cell.value = CellValue::Text(v);
            } else {
                cell.kind = "error".into();
                cell.raw_text = Some(v);
                cell.issues.push(issue(
                    "INVALID_DATE_ONLY",
                    "ISO 日期时间不是合法 YYYY-MM-DD 日期",
                    "error",
                    pos,
                ));
            }
        }
        DataRef::DurationIso(v) => {
            cell.kind = "error".into();
            cell.raw_text = Some(v);
            cell.issues.push(issue(
                "DURATION_UNSUPPORTED",
                "时长不能静默转换为日期",
                "error",
                pos,
            ));
        }
        DataRef::Error(v) => {
            cell.kind = "error".into();
            cell.raw_text = Some(v.to_string());
            cell.issues.push(issue(
                "CELL_ERROR",
                "源单元格为 Excel 错误值，不能当空值导入",
                "error",
                pos,
            ));
        }
    }
    if let CellValue::Text(text) = &cell.value {
        if text.chars().count() > limits.table.max_text_chars {
            return Err(limit("XLSX 单元格文字超过上限"));
        }
    }
    if cell.kind == "text" {
        if let CellValue::Text(v) = &cell.value {
            cell.raw_text = Some(v.clone());
            if v.len() > 1 && v.starts_with('0') && v.bytes().all(|b| b.is_ascii_digit()) {
                cell.issues.push(issue(
                    "LEADING_ZERO_TEXT",
                    "含前导零的源文本已原样保留；字段映射时应保留文本类型",
                    "warning",
                    pos,
                ));
            }
        }
    }
    Ok(cell)
}
fn set_number(value: f64, source: &RawCell, checked: &Preflight, cell: &mut XlsxCell) {
    let raw = source.raw.trim();
    let significant = raw
        .split(['e', 'E'])
        .next()
        .unwrap_or(raw)
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect::<String>()
        .trim_start_matches('0')
        .len();
    let numeric_leading_zero =
        raw.len() > 1 && raw.starts_with('0') && raw.bytes().all(|b| b.is_ascii_digit());
    if !value.is_finite()
        || value.abs() > 9_007_199_254_740_991.0
        || significant > 15
        || numeric_leading_zero
    {
        cell.kind = "error".into();
        cell.issues.push(issue(
            "NUMBER_PRECISION_OR_LEADING_ZERO",
            "数字可能超出精度或含前导零；保留原始词法，请显式按文本导入",
            "error",
            Some(source.pos),
        ));
        return;
    }
    cell.kind = "number".into();
    cell.value = CellValue::Number(if value == 0.0 { 0.0 } else { value });
    if let Some(format) = checked.styles.get(source.style) {
        if *format != 0 {
            let code = checked
                .formats
                .get(format)
                .cloned()
                .unwrap_or_else(|| format!("内置格式 {format}"));
            let message = format!("数字显示格式 {code} 不会保留；预览为原始数值");
            cell.issues.push(issue(
                "NUMBER_FORMAT_NOT_PRESERVED",
                &message,
                "warning",
                Some(source.pos),
            ));
            if code.contains("00") && !code.contains('.') {
                cell.kind = "error".into();
                cell.value = CellValue::Null;
                cell.issues.push(issue(
                    "FORMATTED_LEADING_ZERO",
                    "数字格式可能显示前导零，需显式处理后导入",
                    "error",
                    Some(source.pos),
                ));
            }
        }
    }
}
fn valid_date(value: &str) -> Option<NaiveDate> {
    if value.len() != 10 || value.as_bytes()[4] != b'-' || value.as_bytes()[7] != b'-' {
        return None;
    }
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()?;
    (date.year() >= 1 && date.year() <= 9999 && date.format("%Y-%m-%d").to_string() == value)
        .then_some(date)
}

/// Exports scalar values only. Resolve select/multiSelect option labels explicitly
/// before this call and pass those exchange columns as Text; never export raw IDs.
pub fn export_xlsx(
    columns: &[XlsxExportColumn],
    rows: &[Vec<CellValue>],
    limits: &XlsxLimits,
) -> TableResult<Vec<u8>> {
    if columns.is_empty()
        || columns.len() > limits.table.max_fields
        || rows.len() > limits.table.max_rows
        || rows.len().max(1) * columns.len() > limits.table.max_cells
    {
        return Err(limit("XLSX 导出超过表格行列/单元格上限"));
    }
    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    let date_format = Format::new().set_num_format("yyyy-mm-dd");
    let blank_format = Format::new().set_num_format("@");
    let mut text_bytes = 0usize;
    let mut empty_strings = BTreeSet::new();
    for (col, column) in columns.iter().enumerate() {
        if column.name.trim().is_empty() || column.name.chars().count() > 128 {
            return Err(invalid("XLSX 列名为空或过长"));
        }
        if matches!(column.kind, FieldType::Select | FieldType::MultiSelect) {
            return Err(invalid("选项字段导出前必须显式映射为标签文本"));
        }
        sheet
            .write_string(0, col as u16, &column.name)
            .map_err(|e| invalid(e.to_string()))?;
    }
    for (row, values) in rows.iter().enumerate() {
        if values.len() != columns.len() {
            return Err(invalid("XLSX 导出行的列数不匹配"));
        }
        for (col, (column, value)) in columns.iter().zip(values).enumerate() {
            let r = (row + 1) as u32;
            let c = col as u16;
            match (&column.kind, value) {
                (_, CellValue::Null) => {
                    sheet
                        .write_blank(r, c, &blank_format)
                        .map_err(|e| invalid(e.to_string()))?;
                }
                (FieldType::Text, CellValue::Text(text)) => {
                    text_bytes = text_bytes
                        .checked_add(text.len())
                        .ok_or_else(|| limit("导出文本大小溢出"))?;
                    if text.chars().count() > limits.table.max_text_chars
                        || text.encode_utf16().count() > 32767
                        || text_bytes > limits.table.max_file_bytes
                    {
                        return Err(limit("XLSX 导出文本超过上限"));
                    }
                    if text.is_empty() {
                        empty_strings.insert(cell_address(r, c));
                        sheet
                            .write_blank(r, c, &blank_format)
                            .map_err(|e| invalid(e.to_string()))?;
                    } else {
                        sheet
                            .write_string(r, c, text)
                            .map_err(|e| invalid(e.to_string()))?;
                    }
                }
                (FieldType::Number, CellValue::Number(v))
                    if v.is_finite() && v.abs() <= 9_007_199_254_740_991.0 =>
                {
                    let spelling = v.to_string();
                    let digits = spelling
                        .split(['e', 'E'])
                        .next()
                        .unwrap_or(&spelling)
                        .chars()
                        .filter(|c| c.is_ascii_digit())
                        .collect::<String>();
                    if digits.trim_start_matches('0').len() > 15 {
                        return Err(invalid(
                            "数字超过 Excel 15 位有效数字范围，请显式作为文本导出",
                        ));
                    }
                    sheet
                        .write_number(r, c, *v)
                        .map_err(|e| invalid(e.to_string()))?;
                }
                (FieldType::Checkbox, CellValue::Checkbox(v)) => {
                    sheet
                        .write_boolean(r, c, *v)
                        .map_err(|e| invalid(e.to_string()))?;
                }
                (FieldType::Date, CellValue::Text(value)) => {
                    let date = valid_date(value).ok_or_else(|| invalid("XLSX 导出日期无效"))?;
                    let date = ExcelDateTime::from_ymd(
                        date.year() as u16,
                        date.month() as u8,
                        date.day() as u8,
                    )
                    .map_err(|e| invalid(format!("日期无法使用 Excel 1900 日期系统导出：{e}")))?;
                    sheet
                        .write_datetime_with_format(r, c, &date, &date_format)
                        .map_err(|e| invalid(e.to_string()))?;
                }
                _ => {
                    return Err(invalid(format!(
                        "第 {} 行第 {} 列类型不匹配",
                        row + 1,
                        col + 1
                    )))
                }
            }
        }
    }
    let bytes = workbook
        .save_to_buffer()
        .map_err(|e| invalid(format!("XLSX 导出失败：{e}")))?;
    let bytes = if empty_strings.is_empty() {
        bytes
    } else {
        preserve_empty_strings(bytes, &empty_strings)?
    };
    if bytes.len() > limits.max_import_bytes {
        return Err(limit("XLSX 导出文件超过字节上限"));
    }
    Ok(bytes)
}

fn cell_address(row: u32, col: u16) -> String {
    let mut n = col as usize + 1;
    let mut letters = Vec::new();
    while n > 0 {
        letters.push((b'A' + ((n - 1) % 26) as u8) as char);
        n = (n - 1) / 26;
    }
    format!(
        "{}{}",
        letters.into_iter().rev().collect::<String>(),
        row + 1
    )
}
// Writer deliberately omits empty strings. Replace only our known blank placeholders
// with explicit inline strings in the generated package; never introduce a formula.
fn preserve_empty_strings(bytes: Vec<u8>, empty: &BTreeSet<String>) -> TableResult<Vec<u8>> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| invalid(e.to_string()))?;
    let mut output = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let mut replaced = 0;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| invalid(e.to_string()))?;
        if file.name() != "xl/worksheets/sheet1.xml" {
            output
                .raw_copy_file(file)
                .map_err(|e| invalid(e.to_string()))?;
            continue;
        }
        let mut xml = String::new();
        file.read_to_string(&mut xml)
            .map_err(|e| invalid(e.to_string()))?;
        let mut reader = XmlReader::from_str(&xml);
        let mut writer = quick_xml::Writer::new(Vec::new());
        loop {
            let event = reader.read_event().map_err(|e| invalid(e.to_string()))?;
            if let Event::Empty(ref e) = event {
                if e.local_name().as_ref() == b"c" {
                    let address = e
                        .attributes()
                        .filter_map(Result::ok)
                        .find(|a| a.key.as_ref() == b"r")
                        .map(|a| String::from_utf8_lossy(a.value.as_ref()).to_string());
                    if let Some(address) = address.filter(|a| empty.contains(a)) {
                        write!(
                            writer.get_mut(),
                            "<c r=\"{address}\" t=\"inlineStr\"><is><t></t></is></c>"
                        )
                        .map_err(|e| invalid(e.to_string()))?;
                        replaced += 1;
                        continue;
                    }
                }
            }
            if matches!(event, Event::Eof) {
                break;
            }
            writer
                .write_event(event)
                .map_err(|e| invalid(e.to_string()))?;
        }
        output
            .start_file(
                "xl/worksheets/sheet1.xml",
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated),
            )
            .map_err(|e| invalid(e.to_string()))?;
        output
            .write_all(&writer.into_inner())
            .map_err(|e| invalid(e.to_string()))?;
    }
    if replaced != empty.len() {
        return Err(invalid("XLSX 空文本占位未完整写出，已中止导出"));
    }
    Ok(output
        .finish()
        .map_err(|e| invalid(e.to_string()))?
        .into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn fixture(sheet: &str, epoch: bool, extra: &[(&str, &str)]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let workbook = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="{}"/><sheets><sheet name="数据" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
            u8::from(epoch)
        );
        let wrapped = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">{sheet}</worksheet>"#
        );
        let entries = vec![
            (
                "[Content_Types].xml",
                r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
            ),
            ("xl/workbook.xml", workbook.as_str()),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
            ),
            (
                "xl/styles.xml",
                r#"<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="000000"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>"#,
            ),
            ("xl/worksheets/sheet1.xml", wrapped.as_str()),
        ];
        for (name, body) in entries.into_iter().chain(extra.iter().copied()) {
            zip.start_file(
                name,
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }
    fn preview(sheet: &str) -> XlsxPreview {
        preview_xlsx(&fixture(sheet, false, &[]), 0, 100, &XlsxLimits::default()).unwrap()
    }

    fn rewrite(bytes: &[u8], changes: &[(&str, &str)], additions: &[(&str, &str)]) -> Vec<u8> {
        let mut old = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut new = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for i in 0..old.len() {
            let mut file = old.by_index(i).unwrap();
            let name = file.name().to_string();
            let mut body = Vec::new();
            file.read_to_end(&mut body).unwrap();
            let replacement = changes
                .iter()
                .find(|(n, _)| *n == name)
                .map(|(_, v)| v.as_bytes())
                .unwrap_or(&body);
            new.start_file(
                name,
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
            new.write_all(replacement).unwrap();
        }
        for (name, value) in additions {
            new.start_file(
                *name,
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
            new.write_all(value.as_bytes()).unwrap();
        }
        new.finish().unwrap().into_inner()
    }
    #[test]
    fn selects_named_sheet_and_preserves_empty_sheet() {
        let workbook = r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="空表" sheetId="1" r:id="rId1"/><sheet name="记录" sheetId="2" r:id="rId2" state="hidden"/></sheets></workbook>"#;
        let rels = r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>"#;
        let sheet = r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>第二张</t></is></c></row></sheetData></worksheet>"#;
        let bytes = rewrite(
            &fixture("<sheetData/>", false, &[]),
            &[
                ("xl/workbook.xml", workbook),
                ("xl/_rels/workbook.xml.rels", rels),
            ],
            &[("xl/worksheets/sheet2.xml", sheet)],
        );
        let info = inspect_xlsx(&bytes, &XlsxLimits::default()).unwrap();
        assert_eq!(info.sheet_names, vec!["空表", "记录"]);
        assert!(info.issues.iter().any(|i| i.code == "HIDDEN_SHEET"));
        assert!(preview_xlsx(&bytes, 0, 10, &XlsxLimits::default())
            .unwrap()
            .rows
            .is_empty());
        assert_eq!(
            preview_xlsx(&bytes, 1, 10, &XlsxLimits::default())
                .unwrap()
                .rows[0][0]
                .value,
            CellValue::Text("第二张".into())
        );
    }
    #[test]
    fn rejects_duplicate_zip_members_before_archive_deduplication() {
        let bytes = fixture(
            "<sheetData/>",
            false,
            &[("docProps/a.xml", "<a/>"), ("docProps/b.xml", "<b/>")],
        );
        let mut bytes = bytes;
        let old = b"docProps/b.xml";
        let new = b"docProps/a.xml";
        for offset in 0..=bytes.len() - old.len() {
            if &bytes[offset..offset + old.len()] == old {
                bytes[offset..offset + old.len()].copy_from_slice(new);
            }
        }
        let error = inspect_xlsx(&bytes, &XlsxLimits::default()).unwrap_err();
        assert!(error.message.contains("重复"));
    }
    #[test]
    fn bounds_actual_expansion_even_when_central_size_is_forged() {
        let bytes = fixture(
            "<sheetData/>",
            false,
            &[(
                "docProps/large.xml",
                &format!("<a>{}</a>", "x".repeat(8000)),
            )],
        );
        let mut bytes = bytes;
        // Claim every member expands to one byte, while keeping real compressed streams.
        for offset in 0..bytes.len() - 46 {
            if bytes.get(offset..offset + 4) == Some(b"PK\x01\x02") {
                bytes[offset + 24..offset + 28].copy_from_slice(&1u32.to_le_bytes());
            }
        }
        let mut l = XlsxLimits::default();
        l.max_uncompressed_bytes = 5000;
        assert!(inspect_xlsx(&bytes, &l).is_err());
    }
    #[test]
    fn preserves_scalar_types_and_empty_text() {
        let p = preview(
            r#"<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>名称&amp;备注</t></is></c><c r="B1" t="inlineStr"><is><t></t></is></c><c r="C1"><v>0</v></c><c r="D1" t="b"><v>0</v></c><c r="E1"/><c r="F1" t="inlineStr"><is><t>00123</t></is></c></row></sheetData>"#,
        );
        assert_eq!(p.rows[0][0].value, CellValue::Text("名称&备注".into()));
        assert_eq!(p.rows[0][1].value, CellValue::Text("".into()));
        assert_eq!(p.rows[0][2].value, CellValue::Number(0.0));
        assert_eq!(p.rows[0][3].value, CellValue::Checkbox(false));
        assert_eq!(p.rows[0][4].value, CellValue::Null);
        assert_eq!(p.rows[0][5].value, CellValue::Text("00123".into()));
        assert!(p.issues.iter().any(|i| i.code == "LEADING_ZERO_TEXT"));
    }
    #[test]
    fn flags_precision_formats_errors_merges_and_formula_caches() {
        let p = preview(
            r#"<sheetData><row r="1"><c r="A1"><v>9007199254740993</v></c><c r="B1" s="2"><v>123</v></c><c r="C1" t="e"><v>#DIV/0!</v></c><c r="D1"><f>1+1</f><v>2</v></c><c r="E1"><f>1+2</f></c><c r="F1" t="str"><f>""</f><v></v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A2:B2"/></mergeCells>"#,
        );
        assert_eq!(p.rows[0][0].raw_text.as_deref(), Some("9007199254740993"));
        assert_eq!(p.rows[0][0].kind, "error");
        assert_eq!(p.rows[0][1].kind, "error");
        assert_eq!(p.rows[0][2].kind, "error");
        assert_eq!(p.rows[0][3].value, CellValue::Number(2.0));
        assert_eq!(p.rows[0][4].kind, "error");
        assert_eq!(p.rows[0][5].value, CellValue::Text("".into()));
        for code in [
            "NUMBER_PRECISION_OR_LEADING_ZERO",
            "FORMATTED_LEADING_ZERO",
            "CELL_ERROR",
            "FORMULA_CACHED_VALUE",
            "FORMULA_CACHE_MISSING",
            "MERGED_CELLS",
        ] {
            assert!(p.issues.iter().any(|i| i.code == code), "missing {code}");
        }
    }
    #[test]
    fn checks_1900_leap_bug_and_1904_epoch_and_time() {
        let p = preview(
            r#"<sheetData><row r="1"><c r="A1" s="1"><v>59</v></c><c r="B1" s="1"><v>60</v></c><c r="C1" s="1"><v>61</v></c><c r="D1" s="1"><v>61.5</v></c><c r="E1" s="1"><v>0</v></c></row></sheetData>"#,
        );
        assert_eq!(p.rows[0][0].value, CellValue::Text("1900-02-28".into()));
        assert_eq!(p.rows[0][1].kind, "error");
        assert_eq!(p.rows[0][2].value, CellValue::Text("1900-03-01".into()));
        assert_eq!(p.rows[0][3].kind, "error");
        assert_eq!(p.rows[0][4].value, CellValue::Text("1899-12-31".into()));
        let p = preview_xlsx(
            &fixture(
                r#"<sheetData><row r="1"><c r="A1" s="1"><v>0</v></c></row></sheetData>"#,
                true,
                &[],
            ),
            0,
            10,
            &XlsxLimits::default(),
        )
        .unwrap();
        assert_eq!(p.rows[0][0].value, CellValue::Text("1904-01-01".into()));
    }
    #[test]
    fn rejects_allocation_and_coordinate_bombs_before_calamine() {
        let l = XlsxLimits::default();
        let shared = r#"<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" uniqueCount="999999999999"><si><t>a</t></si></sst>"#;
        assert_eq!(
            inspect_xlsx(
                &fixture("<sheetData/>", false, &[("xl/sharedStrings.xml", shared)]),
                &l
            )
            .unwrap_err()
            .code,
            "LIMIT_EXCEEDED"
        );
        for cells in [
            r#"<sheetData><row r="1"><c r="XFD1048576"><v>1</v></c></row></sheetData>"#,
            r#"<sheetData><row r="1"><c r="A1"><f t="shared" si="999999999999"/><v>1</v></c></row></sheetData>"#,
        ] {
            assert_eq!(
                inspect_xlsx(&fixture(cells, false, &[]), &l)
                    .unwrap_err()
                    .code,
                "LIMIT_EXCEEDED"
            );
        }
        let text = "a".repeat(l.table.max_text_chars + 1);
        let cell=format!("<sheetData><row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>{text}</t></is></c></row></sheetData>");
        assert_eq!(
            inspect_xlsx(&fixture(&cell, false, &[]), &l)
                .unwrap_err()
                .code,
            "LIMIT_EXCEEDED"
        );
    }
    #[test]
    fn rejects_bad_xml_oversized_archive_and_expansion() {
        assert!(inspect_xlsx(
            &fixture("<sheetData><row>", false, &[]),
            &XlsxLimits::default()
        )
        .is_err());
        let bytes = fixture("<sheetData/>", false, &[]);
        let mut l = XlsxLimits::default();
        l.max_import_bytes = 16;
        assert_eq!(inspect_xlsx(&bytes, &l).unwrap_err().code, "LIMIT_EXCEEDED");
        l.max_import_bytes = 64 * 1024 * 1024;
        l.max_uncompressed_bytes = 100;
        assert_eq!(inspect_xlsx(&bytes, &l).unwrap_err().code, "LIMIT_EXCEEDED");
        l.max_uncompressed_bytes = 64 * 1024 * 1024;
        l.max_zip_entries = 2;
        assert_eq!(inspect_xlsx(&bytes, &l).unwrap_err().code, "LIMIT_EXCEEDED");
        assert!(inspect_xlsx(b"not a zip", &l).is_err());
    }
    #[test]
    fn export_roundtrip_never_interprets_user_text_as_formula() {
        let columns = vec![
            XlsxExportColumn {
                name: "文本".into(),
                kind: FieldType::Text,
            },
            XlsxExportColumn {
                name: "数字".into(),
                kind: FieldType::Number,
            },
            XlsxExportColumn {
                name: "日期".into(),
                kind: FieldType::Date,
            },
            XlsxExportColumn {
                name: "勾选".into(),
                kind: FieldType::Checkbox,
            },
        ];
        let rows = ["=SUM(A1:A2)", "+1+1", "-1+1", "@SUM(A1:A2)", "", "00123"]
            .iter()
            .map(|text| {
                vec![
                    CellValue::Text((*text).into()),
                    CellValue::Number(0.0),
                    CellValue::Text("2024-02-29".into()),
                    CellValue::Checkbox(false),
                ]
            })
            .collect::<Vec<_>>();
        let bytes = export_xlsx(&columns, &rows, &XlsxLimits::default()).unwrap();
        let p = preview_xlsx(&bytes, 0, 100, &XlsxLimits::default()).unwrap();
        assert_eq!(p.total_rows, rows.len() + 1);
        for (i, row) in rows.iter().enumerate() {
            for (j, value) in row.iter().enumerate() {
                assert_eq!(&p.rows[i + 1][j].value, value, "at {i},{j}");
            }
        }
        assert!(!p.issues.iter().any(|i| i.code == "FORMULA_CACHED_VALUE"));
        let mut archive = zip::ZipArchive::new(Cursor::new(&bytes)).unwrap();
        let mut xml = String::new();
        archive
            .by_name("xl/worksheets/sheet1.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        assert!(!xml.contains("<f>"));
    }
    #[test]
    fn preview_is_bounded_and_checks_all_cells_not_only_visible_rows() {
        let bytes = fixture(
            r#"<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>标题</t></is></c></row><row r="3"><c r="B3" t="e"><v>#N/A</v></c></row></sheetData>"#,
            false,
            &[],
        );
        let p = preview_xlsx(&bytes, 0, 1, &XlsxLimits::default()).unwrap();
        assert_eq!(p.rows.len(), 1);
        assert_eq!(p.total_rows, 3);
        assert!(p.truncated);
        assert!(p
            .issues
            .iter()
            .any(|i| i.code == "CELL_ERROR" && i.row == Some(2)));
        assert!(preview_xlsx(&bytes, 1, 1, &XlsxLimits::default()).is_err());
    }
}
