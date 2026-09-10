use super::model::*;
use chrono::{DateTime, NaiveDate};
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::Value;
use std::{collections::BTreeSet, fmt};

pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
fn error(code: &str, pointer: &str, message: &str) -> TableError {
    TableError::new(code, message, pointer)
}
fn model_error(pointer: &str, message: &str) -> TableError {
    error("INVALID_MODEL", pointer, message)
}
fn segment(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

pub fn valid_id(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|tail| {
        tail.len() == 32
            && tail
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}
pub fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn require_id(value: &str, prefix: &str, pointer: &str) -> TableResult<()> {
    if valid_id(value, prefix) {
        Ok(())
    } else {
        Err(model_error(pointer, "身份格式无效"))
    }
}
pub fn validate_timestamp(
    value: &str,
    pointer: &str,
) -> TableResult<DateTime<chrono::FixedOffset>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .filter(|date| value.ends_with('Z') && date.offset().local_minus_utc() == 0)
        .ok_or_else(|| model_error(pointer, "时间戳必须是有效的 UTC RFC3339"))
}
pub fn valid_date(value: &str) -> bool {
    value.len() == 10
        && value.as_bytes()[4] == b'-'
        && value.as_bytes()[7] == b'-'
        && value
            .bytes()
            .enumerate()
            .all(|(i, c)| matches!(i, 4 | 7) || c.is_ascii_digit())
        && value >= "0001-01-01"
        && value <= "9999-12-31"
        && NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
}
fn valid_number(value: f64) -> bool {
    value.is_finite() && value.abs() <= MAX_SAFE_INTEGER as f64
}
fn label(value: &str, pointer: &str) -> TableResult<()> {
    if value.trim().is_empty() || value.chars().count() > 128 {
        Err(model_error(pointer, "名称不能为空白或超过 128 字符"))
    } else {
        Ok(())
    }
}
pub fn validate_order<'a>(
    order: &[String],
    keys: impl Iterator<Item = &'a String>,
    pointer: &str,
) -> TableResult<()> {
    let expected = keys.map(String::as_str).collect::<BTreeSet<_>>();
    let actual = order.iter().map(String::as_str).collect::<BTreeSet<_>>();
    if order.len() != actual.len() || expected != actual {
        Err(model_error(pointer, "顺序必须是实体 ID 的完整无重复排列"))
    } else {
        Ok(())
    }
}

// Preserve raw duplicate keys before ordinary map deserialization loses them.
struct UniqueSeed {
    path: String,
}
impl<'de> DeserializeSeed<'de> for UniqueSeed {
    type Value = Value;
    fn deserialize<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for UniqueSeed {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("strict JSON without duplicate keys")
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Value, E> {
        Ok(Value::Bool(v))
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Value, E> {
        Ok(v.into())
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Value, E> {
        Ok(v.into())
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Value, E> {
        serde_json::Number::from_f64(v)
            .map(Value::Number)
            .ok_or_else(|| E::custom("non-finite number"))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Value, E> {
        Ok(Value::String(v.into()))
    }
    fn visit_string<E: de::Error>(self, v: String) -> Result<Value, E> {
        Ok(Value::String(v))
    }
    fn visit_none<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut result = Vec::new();
        while let Some(value) = seq.next_element_seed(UniqueSeed {
            path: format!("{}/{}", self.path, result.len()),
        })? {
            result.push(value);
        }
        Ok(Value::Array(result))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut result = serde_json::Map::new();
        while let Some(key) = map.next_key::<String>()? {
            let path = format!("{}/{}", self.path, segment(&key));
            if result.contains_key(&key) {
                return Err(de::Error::custom(format!("DUPLICATE_KEY|{path}|")));
            }
            let value = map.next_value_seed(UniqueSeed { path })?;
            result.insert(key, value);
        }
        Ok(Value::Object(result))
    }
}
fn parse_strict_json(bytes: &[u8], limits: &TableLimits) -> TableResult<Value> {
    if bytes.len() > limits.max_file_bytes {
        return Err(error("LIMIT_EXCEEDED", "", "表文件超过字节上限"));
    }
    let mut parser = serde_json::Deserializer::from_slice(bytes);
    let value = UniqueSeed {
        path: String::new(),
    }
    .deserialize(&mut parser)
    .map_err(|err| {
        let text = err.to_string();
        if let Some(rest) = text.strip_prefix("DUPLICATE_KEY|") {
            error(
                "DUPLICATE_KEY",
                rest.split('|').next().unwrap_or(""),
                "JSON 含重复键",
            )
        } else {
            error("INVALID_JSON", "", &text)
        }
    })?;
    parser
        .end()
        .map_err(|err| error("INVALID_JSON", "", &err.to_string()))?;
    Ok(value)
}

/// Inspect only stable envelope identity. An unsupported body remains its own read error.
pub fn probe_table_identity(bytes: &[u8], limits: &TableLimits) -> TableResult<TableIdentity> {
    let value = parse_strict_json(bytes, limits)?;
    if value.get("kind").and_then(Value::as_str) != Some("shard.table") {
        return Err(model_error("/kind", "文件不是原生数据表"));
    }
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| model_error("/id", "缺少表身份"))?;
    require_id(id, "tbl_", "/id")?;
    let request = value.pointer("/creation/requestId").and_then(Value::as_str);
    if let Some(request) = request {
        require_id(request, "req_", "/creation/requestId")?;
    }
    Ok(TableIdentity {
        table_id: id.into(),
        request_id: request.map(str::to_string),
    })
}

pub fn parse_table_bytes(bytes: &[u8], limits: &TableLimits) -> TableResult<TableFile> {
    let value = parse_strict_json(bytes, limits)?;
    if value.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err(error(
            "UNSUPPORTED_VERSION",
            "/schemaVersion",
            "不支持此表格式版本",
        ));
    }
    let keys = [
        "kind",
        "schemaVersion",
        "id",
        "revision",
        "creation",
        "lastMutationId",
        "lastMutationHash",
        "createdAt",
        "updatedAt",
        "copiedFrom",
        "primaryFieldId",
        "fields",
        "fieldOrder",
        "records",
        "recordOrder",
        "views",
        "viewOrder",
    ];
    if let Some(object) = value.as_object() {
        for key in object.keys() {
            if !keys.contains(&key.as_str()) {
                return Err(model_error(&format!("/{}", segment(key)), "未知表属性"));
            }
        }
    }
    if let Some(fields) = value.get("fields").and_then(Value::as_object) {
        for (id, field) in fields {
            if !matches!(
                field.get("type").and_then(Value::as_str),
                Some("text" | "number" | "date" | "select" | "multiSelect" | "checkbox")
            ) {
                return Err(model_error(
                    &format!("/fields/{}/type", segment(id)),
                    "未知字段类型",
                ));
            }
        }
    }
    if let Some(views) = value.get("views").and_then(Value::as_object) {
        for (id, view) in views {
            if let Some(conditions) = view
                .pointer("/filters/conditions")
                .and_then(Value::as_array)
            {
                for (index, condition) in conditions.iter().enumerate() {
                    serde_json::from_value::<FilterCondition>(condition.clone()).map_err(
                        |err| {
                            error(
                                "INVALID_FILTER",
                                &format!("/views/{}/filters/conditions/{index}", segment(id)),
                                &err.to_string(),
                            )
                        },
                    )?;
                }
            }
        }
    }
    let file: TableFile =
        serde_json::from_value(value).map_err(|err| model_error("", &err.to_string()))?;
    validate_table(&file, limits)?;
    Ok(file)
}

// Only the strict parser can construct this token. Keeping the exact limits with
// the immutable file lets storage avoid revalidating that same input before apply.
pub(super) struct ParsedTableFile {
    file: TableFile,
    limits: TableLimits,
}
impl ParsedTableFile {
    pub(super) fn file(&self) -> &TableFile {
        &self.file
    }
    pub(super) fn limits(&self) -> &TableLimits {
        &self.limits
    }
    pub(super) fn into_file(self) -> TableFile {
        self.file
    }
}
pub(super) fn parse_validated_table_bytes(
    bytes: &[u8],
    limits: &TableLimits,
) -> TableResult<ParsedTableFile> {
    Ok(ParsedTableFile {
        file: parse_table_bytes(bytes, limits)?,
        limits: limits.clone(),
    })
}

pub fn validate_field(field: &TableField, pointer: &str, limits: &TableLimits) -> TableResult<()> {
    require_id(&field.id, "fld_", &format!("{pointer}/id"))?;
    label(&field.name, &format!("{pointer}/name"))?;
    match field.field_type {
        FieldType::Select | FieldType::MultiSelect => {
            let options = field.options.as_ref().ok_or_else(|| {
                model_error(&format!("{pointer}/options"), "选项字段必须提供 options")
            })?;
            if options.len() > limits.max_options {
                return Err(error(
                    "LIMIT_EXCEEDED",
                    &format!("{pointer}/options"),
                    "选项过多",
                ));
            }
            let mut ids = BTreeSet::new();
            for option in options {
                require_id(&option.id, "opt_", &format!("{pointer}/options"))?;
                label(&option.label, &format!("{pointer}/options"))?;
                if !ids.insert(&option.id) {
                    return Err(model_error(&format!("{pointer}/options"), "选项 ID 重复"));
                }
            }
        }
        _ => {
            if field.options.is_some() {
                return Err(model_error(
                    &format!("{pointer}/options"),
                    "此字段不支持 options",
                ));
            }
        }
    }
    Ok(())
}
fn has_option(field: &TableField, id: &str) -> bool {
    field
        .options
        .as_ref()
        .is_some_and(|options| options.iter().any(|option| option.id == id))
}
pub fn validate_cell(
    value: &CellValue,
    field: &TableField,
    pointer: &str,
    limits: &TableLimits,
) -> TableResult<()> {
    let valid = match (value, field.field_type) {
        (CellValue::Null, _) => true,
        (CellValue::Text(text), FieldType::Text) => text.chars().count() <= limits.max_text_chars,
        (CellValue::Text(text), FieldType::Date) => valid_date(text),
        (CellValue::Text(text), FieldType::Select) => has_option(field, text),
        (CellValue::Number(value), FieldType::Number) => valid_number(*value),
        (CellValue::Checkbox(_), FieldType::Checkbox) => true,
        (CellValue::OptionIds(ids), FieldType::MultiSelect) => {
            ids.len() <= limits.max_options
                && ids.iter().all(|id| has_option(field, id))
                && ids.iter().collect::<BTreeSet<_>>().len() == ids.len()
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(error(
            "INVALID_VALUE",
            pointer,
            "单元格值与字段类型或容量不匹配",
        ))
    }
}
fn scalar_matches(value: &ScalarValue, field: &TableField, limits: &TableLimits) -> bool {
    let value = match value {
        ScalarValue::Text(v) => CellValue::Text(v.clone()),
        ScalarValue::Number(v) => CellValue::Number(*v),
        ScalarValue::Checkbox(v) => CellValue::Checkbox(*v),
    };
    field.field_type != FieldType::MultiSelect && validate_cell(&value, field, "", limits).is_ok()
}
fn ordered_matches(value: &OrderedValue, field: &TableField) -> bool {
    match (value, field.field_type) {
        (OrderedValue::Number(v), FieldType::Number) => valid_number(*v),
        (OrderedValue::Text(v), FieldType::Date) => valid_date(v),
        _ => false,
    }
}
pub fn validate_filter(
    condition: &FilterCondition,
    field: &TableField,
    pointer: &str,
    limits: &TableLimits,
) -> TableResult<()> {
    use FilterCondition::*;
    let valid = match condition {
        IsEmpty { .. } | IsNotEmpty { .. } => true,
        Eq { value, .. } | Ne { value, .. } => scalar_matches(value, field, limits),
        Contains { value, .. }
        | NotContains { value, .. }
        | StartsWith { value, .. }
        | EndsWith { value, .. } => {
            field.field_type == FieldType::Text && value.chars().count() <= limits.max_text_chars
        }
        Gt { value, .. } | Gte { value, .. } | Lt { value, .. } | Lte { value, .. } => {
            ordered_matches(value, field)
        }
        Between { lower, upper, .. } => {
            ordered_matches(lower, field)
                && ordered_matches(upper, field)
                && match (lower, upper) {
                    (OrderedValue::Number(a), OrderedValue::Number(b)) => a <= b,
                    (OrderedValue::Text(a), OrderedValue::Text(b)) => a <= b,
                    _ => false,
                }
        }
        In { option_ids, .. }
        | NotIn { option_ids, .. }
        | HasAny { option_ids, .. }
        | HasAll { option_ids, .. }
        | HasNone { option_ids, .. } => {
            let field_ok = if matches!(condition, In { .. } | NotIn { .. }) {
                field.field_type == FieldType::Select
            } else {
                field.field_type == FieldType::MultiSelect
            };
            field_ok
                && !option_ids.is_empty()
                && option_ids.len() <= limits.max_options
                && option_ids.iter().all(|id| has_option(field, id))
                && option_ids.iter().collect::<BTreeSet<_>>().len() == option_ids.len()
        }
    };
    if valid {
        Ok(())
    } else {
        Err(error(
            "INVALID_FILTER",
            pointer,
            "筛选运算符或参数与字段不匹配",
        ))
    }
}

pub fn validate_table(file: &TableFile, limits: &TableLimits) -> TableResult<()> {
    if file.schema_version != 1 {
        return Err(error(
            "UNSUPPORTED_VERSION",
            "/schemaVersion",
            "不支持此表格式版本",
        ));
    }
    if file.kind != "shard.table" {
        return Err(model_error("/kind", "文件不是原生数据表"));
    }
    require_id(&file.id, "tbl_", "/id")?;
    if file.revision == 0 || file.revision > MAX_SAFE_INTEGER {
        return Err(model_error("/revision", "revision 超出有效范围"));
    }
    require_id(&file.creation.request_id, "req_", "/creation/requestId")?;
    if !valid_hash(&file.creation.payload_hash) {
        return Err(model_error("/creation/payloadHash", "创建 hash 无效"));
    }
    match (&file.last_mutation_id, &file.last_mutation_hash) {
        (None, None) => {}
        (Some(id), Some(hash)) => {
            require_id(id, "mut_", "/lastMutationId")?;
            if !valid_hash(hash) {
                return Err(model_error("/lastMutationHash", "操作 hash 无效"));
            }
        }
        _ => {
            return Err(model_error(
                "/lastMutationHash",
                "操作 ID/hash 必须同时为空或同时存在",
            ))
        }
    }
    let created = validate_timestamp(&file.created_at, "/createdAt")?;
    if validate_timestamp(&file.updated_at, "/updatedAt")? < created {
        return Err(model_error("/updatedAt", "修改时间早于创建时间"));
    }
    if let Some(source) = &file.copied_from {
        require_id(&source.table_id, "tbl_", "/copiedFrom/tableId")?;
        if source.table_id == file.id
            || source.revision == 0
            || source.revision > MAX_SAFE_INTEGER
            || !valid_hash(&source.content_hash)
        {
            return Err(model_error("/copiedFrom", "副本来源无效"));
        }
    }
    if file.fields.is_empty() || file.views.is_empty() {
        return Err(model_error("/fields", "至少保留一个字段和视图"));
    }
    if file.records.len() > limits.max_rows
        || file.fields.len() > limits.max_fields
        || file.records.len().max(1).saturating_mul(file.fields.len()) > limits.max_cells
        || file.views.len() > limits.max_views
    {
        return Err(error(
            "LIMIT_EXCEEDED",
            "",
            "数据表超过行/列/视图/单元格容量",
        ));
    }
    if !file
        .fields
        .get(&file.primary_field_id)
        .is_some_and(|f| f.field_type == FieldType::Text)
    {
        return Err(model_error("/primaryFieldId", "主字段必须是现存文本字段"));
    }
    validate_order(&file.field_order, file.fields.keys(), "/fieldOrder")?;
    validate_order(&file.record_order, file.records.keys(), "/recordOrder")?;
    validate_order(&file.view_order, file.views.keys(), "/viewOrder")?;
    for (id, field) in &file.fields {
        let p = format!("/fields/{}", segment(id));
        if id != &field.id {
            return Err(model_error(&format!("{p}/id"), "字段 ID 与索引不一致"));
        }
        validate_field(field, &p, limits)?;
    }
    for (id, record) in &file.records {
        let p = format!("/records/{}", segment(id));
        require_id(id, "rec_", &format!("{p}/id"))?;
        if id != &record.id {
            return Err(model_error(&format!("{p}/id"), "记录 ID 与索引不一致"));
        }
        let created = validate_timestamp(&record.created_at, &format!("{p}/createdAt"))?;
        if validate_timestamp(&record.updated_at, &format!("{p}/updatedAt"))? < created {
            return Err(model_error(
                &format!("{p}/updatedAt"),
                "修改时间早于创建时间",
            ));
        }
        for (field_id, value) in &record.values {
            let path = format!("{p}/values/{}", segment(field_id));
            let field = file
                .fields
                .get(field_id)
                .ok_or_else(|| model_error(&path, "单元格引用不存在的字段"))?;
            validate_cell(value, field, &path, limits)?;
        }
    }
    for (id, view) in &file.views {
        let p = format!("/views/{}", segment(id));
        require_id(id, "view_", &format!("{p}/id"))?;
        if id != &view.id {
            return Err(model_error(&format!("{p}/id"), "视图 ID 与索引不一致"));
        }
        if view.view_type != "table" {
            return Err(model_error(&format!("{p}/type"), "不支持此视图类型"));
        }
        label(&view.name, &format!("{p}/name"))?;
        validate_order(
            &view.field_order,
            file.fields.keys(),
            &format!("{p}/fieldOrder"),
        )?;
        if view.hidden_field_ids.iter().collect::<BTreeSet<_>>().len()
            != view.hidden_field_ids.len()
            || view
                .hidden_field_ids
                .iter()
                .any(|id| id == &file.primary_field_id || !file.fields.contains_key(id))
        {
            return Err(model_error(
                &format!("{p}/hiddenFieldIds"),
                "隐藏字段重复、缺失或包含主字段",
            ));
        }
        for (field_id, width) in &view.column_widths {
            if !file.fields.contains_key(field_id) || !(64..=1200).contains(width) {
                return Err(model_error(
                    &format!("{p}/columnWidths/{}", segment(field_id)),
                    "列宽或字段无效",
                ));
            }
        }
        if let Some(group) = &view.group_by {
            if !file
                .fields
                .get(group)
                .is_some_and(|field| field.field_type != FieldType::MultiSelect)
            {
                return Err(model_error(
                    &format!("{p}/groupBy"),
                    "分组字段不存在或不支持多选分组",
                ));
            }
        }
        if view.filters.conditions.len() > limits.max_conditions
            || view.sorts.len() > limits.max_sorts
        {
            return Err(error("LIMIT_EXCEEDED", &p, "视图条件过多"));
        }
        let mut sorted = BTreeSet::new();
        for sort in &view.sorts {
            if !file.fields.contains_key(&sort.field_id) || !sorted.insert(&sort.field_id) {
                return Err(model_error(&format!("{p}/sorts"), "排序字段缺失或重复"));
            }
        }
        for (index, condition) in view.filters.conditions.iter().enumerate() {
            let path = format!("{p}/filters/conditions/{index}");
            let field = file
                .fields
                .get(condition.field_id())
                .ok_or_else(|| error("INVALID_FILTER", &path, "筛选字段不存在"))?;
            validate_filter(condition, field, &path, limits)?;
        }
    }
    Ok(())
}

pub fn normalize_values(file: &mut TableFile) {
    for record in file.records.values_mut() {
        record
            .values
            .retain(|_, value| !matches!(value, CellValue::Null));
        for value in record.values.values_mut() {
            match value {
                CellValue::OptionIds(ids) => ids.sort(),
                CellValue::Number(v) if *v == 0.0 => *v = 0.0,
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    fn fixtures() -> PathBuf {
        option_env!("SHARD_TABLE_FIXTURES")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/tables")
            })
    }
    #[test]
    fn reads_shared_valid_and_rejects_each_invalid_fixture() {
        let root = fixtures();
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(root.join("manifest.json")).unwrap()).unwrap();
        for entry in manifest["valid"].as_array().unwrap() {
            let path = root.join(entry["file"].as_str().unwrap());
            parse_table_bytes(&std::fs::read(&path).unwrap(), &TableLimits::default())
                .unwrap_or_else(|e| panic!("{}: {e:?}", path.display()));
        }
        for entry in manifest["invalid"].as_array().unwrap() {
            let path = root.join(entry["file"].as_str().unwrap());
            let err = parse_table_bytes(&std::fs::read(&path).unwrap(), &TableLimits::default())
                .unwrap_err();
            assert_eq!(
                err.code,
                entry["code"].as_str().unwrap(),
                "{}: {err:?}",
                path.display()
            );
            assert_eq!(
                err.pointer.as_deref(),
                entry["pointer"].as_str(),
                "{}: {err:?}",
                path.display()
            );
        }
    }
    #[test]
    fn raw_byte_limit_and_trailing_json_are_rejected() {
        let bytes = std::fs::read(fixtures().join("valid/empty.json")).unwrap();
        let mut limits = TableLimits::default();
        limits.max_file_bytes = bytes.len() - 1;
        assert_eq!(
            parse_table_bytes(&bytes, &limits).unwrap_err().code,
            "LIMIT_EXCEEDED"
        );
        let mut trailing = bytes;
        trailing.extend_from_slice(b"{}");
        assert_eq!(
            parse_table_bytes(&trailing, &TableLimits::default())
                .unwrap_err()
                .code,
            "INVALID_JSON"
        );
    }
    #[test]
    fn direct_cell_deserialization_matches_prior_wire_and_rejects_non_string_arrays() {
        #[derive(serde::Serialize, serde::Deserialize)]
        #[serde(untagged)]
        enum PriorCellValue {
            Null,
            Checkbox(bool),
            Number(f64),
            Text(String),
            OptionIds(Vec<String>),
        }
        let cases: Value = serde_json::from_slice(
            &std::fs::read(fixtures().join("cell-wire-cases.json")).unwrap(),
        )
        .unwrap();
        let file = parse_table_bytes(
            &std::fs::read(fixtures().join("valid/six-types.json")).unwrap(),
            &TableLimits::default(),
        )
        .unwrap();
        for case in cases["valid"].as_array().unwrap() {
            let current: CellValue = serde_json::from_value(case["value"].clone()).unwrap();
            let prior: PriorCellValue = serde_json::from_value(case["value"].clone()).unwrap();
            assert_eq!(
                serde_json::to_vec(&current).unwrap(),
                serde_json::to_vec(&prior).unwrap()
            );
            let field_type: FieldType = serde_json::from_value(case["fieldType"].clone()).unwrap();
            let field = file
                .fields
                .values()
                .find(|field| field.field_type == field_type)
                .unwrap();
            validate_cell(&current, field, "", &TableLimits::default()).unwrap();
        }
        for case in cases["invalid"].as_array().unwrap() {
            assert!(
                serde_json::from_value::<CellValue>(case["value"].clone()).is_err(),
                "{case}"
            );
            assert!(
                serde_json::from_value::<PriorCellValue>(case["value"].clone()).is_err(),
                "{case}"
            );
        }
    }
}
