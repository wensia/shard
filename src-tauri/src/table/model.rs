use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub type TableResult<T> = Result<T, TableError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TableError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pointer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_id: Option<String>,
}

impl TableError {
    pub fn new(code: &str, message: impl Into<String>, pointer: impl Into<String>) -> Self {
        let pointer = pointer.into();
        Self {
            code: code.into(),
            message: message.into(),
            pointer: (!pointer.is_empty()).then_some(pointer),
            operation_index: None,
            record_id: None,
            field_id: None,
        }
    }
    pub fn at_operation(mut self, index: usize) -> Self {
        self.operation_index = Some(index);
        self
    }
}

#[derive(Debug, Clone)]
pub struct TableLimits {
    pub max_rows: usize,
    pub max_fields: usize,
    pub max_cells: usize,
    pub max_file_bytes: usize,
    pub max_text_chars: usize,
    pub max_views: usize,
    pub max_options: usize,
    pub max_conditions: usize,
    pub max_sorts: usize,
    pub max_operations: usize,
    pub max_explicit_cells: usize,
    pub max_request_bytes: usize,
}
impl Default for TableLimits {
    fn default() -> Self {
        Self {
            max_rows: 10_000,
            max_fields: 128,
            max_cells: 300_000,
            max_file_bytes: 64 * 1024 * 1024,
            max_text_chars: 16_384,
            max_views: 32,
            max_options: 256,
            max_conditions: 64,
            max_sorts: 16,
            max_operations: 64,
            max_explicit_cells: 50_000,
            max_request_bytes: 16 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(untagged)]
pub enum CellValue {
    Null,
    Checkbox(bool),
    Number(f64),
    Text(String),
    OptionIds(Vec<String>),
}

// JSON's token type fully identifies these variants. Avoid untagged trial/error
// deserialization for every cell while keeping the same scalar/array wire format.
impl<'de> Deserialize<'de> for CellValue {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct CellVisitor;
        impl<'de> serde::de::Visitor<'de> for CellVisitor {
            type Value = CellValue;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("null, boolean, number, string, or an array of strings")
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(CellValue::Null)
            }
            fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<Self::Value, E> {
                Ok(CellValue::Checkbox(value))
            }
            fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Self::Value, E> {
                Ok(CellValue::Number(value as f64))
            }
            fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Self::Value, E> {
                Ok(CellValue::Number(value as f64))
            }
            fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Self::Value, E> {
                Ok(CellValue::Number(value))
            }
            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
                Ok(CellValue::Text(value.into()))
            }
            fn visit_string<E: serde::de::Error>(self, value: String) -> Result<Self::Value, E> {
                Ok(CellValue::Text(value))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = sequence.next_element::<String>()? {
                    values.push(value);
                }
                Ok(CellValue::OptionIds(values))
            }
        }
        deserializer.deserialize_any(CellVisitor)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FieldType {
    Text,
    Number,
    Date,
    Select,
    MultiSelect,
    Checkbox,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectOption {
    pub id: String,
    pub label: String,
    pub color: OptionColor,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OptionColor {
    Neutral,
    Red,
    Orange,
    Yellow,
    Green,
    Blue,
    Purple,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableField {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub field_type: FieldType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<SelectOption>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableRecord {
    pub id: String,
    pub created_at: String,
    pub updated_at: String,
    pub values: BTreeMap<String, CellValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum ScalarValue {
    Checkbox(bool),
    Number(f64),
    Text(String),
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum OrderedValue {
    Number(f64),
    Text(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "operator",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FilterCondition {
    IsEmpty {
        field_id: String,
    },
    IsNotEmpty {
        field_id: String,
    },
    Eq {
        field_id: String,
        value: ScalarValue,
    },
    Ne {
        field_id: String,
        value: ScalarValue,
    },
    Contains {
        field_id: String,
        value: String,
    },
    NotContains {
        field_id: String,
        value: String,
    },
    StartsWith {
        field_id: String,
        value: String,
    },
    EndsWith {
        field_id: String,
        value: String,
    },
    Gt {
        field_id: String,
        value: OrderedValue,
    },
    Gte {
        field_id: String,
        value: OrderedValue,
    },
    Lt {
        field_id: String,
        value: OrderedValue,
    },
    Lte {
        field_id: String,
        value: OrderedValue,
    },
    Between {
        field_id: String,
        lower: OrderedValue,
        upper: OrderedValue,
    },
    In {
        field_id: String,
        option_ids: Vec<String>,
    },
    NotIn {
        field_id: String,
        option_ids: Vec<String>,
    },
    HasAny {
        field_id: String,
        option_ids: Vec<String>,
    },
    HasAll {
        field_id: String,
        option_ids: Vec<String>,
    },
    HasNone {
        field_id: String,
        option_ids: Vec<String>,
    },
}
impl FilterCondition {
    pub fn field_id(&self) -> &str {
        match self {
            Self::IsEmpty { field_id }
            | Self::IsNotEmpty { field_id }
            | Self::Eq { field_id, .. }
            | Self::Ne { field_id, .. }
            | Self::Contains { field_id, .. }
            | Self::NotContains { field_id, .. }
            | Self::StartsWith { field_id, .. }
            | Self::EndsWith { field_id, .. }
            | Self::Gt { field_id, .. }
            | Self::Gte { field_id, .. }
            | Self::Lt { field_id, .. }
            | Self::Lte { field_id, .. }
            | Self::Between { field_id, .. }
            | Self::In { field_id, .. }
            | Self::NotIn { field_id, .. }
            | Self::HasAny { field_id, .. }
            | Self::HasAll { field_id, .. }
            | Self::HasNone { field_id, .. } => field_id,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FilterOperator {
    And,
    Or,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableFilter {
    pub operator: FilterOperator,
    pub conditions: Vec<FilterCondition>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SortDirection {
    Asc,
    Desc,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableSort {
    pub field_id: String,
    pub direction: SortDirection,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableView {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub view_type: String,
    pub filters: TableFilter,
    pub sorts: Vec<TableSort>,
    pub group_by: Option<String>,
    pub field_order: Vec<String>,
    pub hidden_field_ids: Vec<String>,
    pub column_widths: BTreeMap<String, u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableContent {
    pub primary_field_id: String,
    pub fields: BTreeMap<String, TableField>,
    pub field_order: Vec<String>,
    pub records: BTreeMap<String, TableRecord>,
    pub record_order: Vec<String>,
    pub views: BTreeMap<String, TableView>,
    pub view_order: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreationIdentity {
    pub request_id: String,
    pub payload_hash: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CopySource {
    pub table_id: String,
    pub revision: u64,
    pub content_hash: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableFile {
    pub kind: String,
    pub schema_version: u32,
    pub id: String,
    pub revision: u64,
    pub creation: CreationIdentity,
    pub last_mutation_id: Option<String>,
    pub last_mutation_hash: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copied_from: Option<CopySource>,
    pub primary_field_id: String,
    pub fields: BTreeMap<String, TableField>,
    pub field_order: Vec<String>,
    pub records: BTreeMap<String, TableRecord>,
    pub record_order: Vec<String>,
    pub views: BTreeMap<String, TableView>,
    pub view_order: Vec<String>,
}
impl TableFile {
    #[cfg(test)]
    pub fn content(&self) -> TableContent {
        TableContent {
            primary_field_id: self.primary_field_id.clone(),
            fields: self.fields.clone(),
            field_order: self.field_order.clone(),
            records: self.records.clone(),
            record_order: self.record_order.clone(),
            views: self.views.clone(),
            view_order: self.view_order.clone(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CellEdit {
    pub record_id: String,
    pub field_id: String,
    pub value: CellValue,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewRecord {
    pub id: String,
    pub values: BTreeMap<String, CellValue>,
    pub created_at: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TableMutation {
    SetCells {
        cells: Vec<CellEdit>,
    },
    InsertRecords {
        records: Vec<NewRecord>,
        before_record_id: Option<String>,
    },
    DeleteRecords {
        record_ids: Vec<String>,
    },
    SetRecordOrder {
        record_ids: Vec<String>,
    },
    PutField {
        field: TableField,
        before_field_id: Option<String>,
    },
    DeleteField {
        field_id: String,
    },
    SetFieldOrder {
        field_ids: Vec<String>,
    },
    PutView {
        view: TableView,
        before_view_id: Option<String>,
    },
    DeleteView {
        view_id: String,
    },
    SetViewOrder {
        view_ids: Vec<String>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyTableMutationsRequest {
    pub path: String,
    pub table_id: String,
    pub expected_revision: u64,
    pub expected_hash: String,
    pub mutation_id: String,
    pub operations: Vec<TableMutation>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyTableMutationsResult {
    pub table_id: String,
    pub path: String,
    pub mutation_id: String,
    pub base_revision: u64,
    pub revision: u64,
    pub content_hash: String,
    pub updated_at: String,
    pub changed_records: Vec<TableRecord>,
    pub deleted_record_ids: Vec<String>,
    pub changed_fields: Vec<TableField>,
    pub deleted_field_ids: Vec<String>,
    pub changed_views: Vec<TableView>,
    pub deleted_view_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_order: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record_order: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_order: Option<Vec<String>>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateTableRequest {
    pub request_id: String,
    pub table_id: String,
    pub parent_path: String,
    pub suggested_name: String,
    pub content: TableContent,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadTableRequest {
    pub path: String,
    pub expected_table_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableIdentity {
    pub table_id: String,
    pub request_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveTableCopyRequest {
    pub request_id: String,
    pub table_id: String,
    pub parent_path: String,
    pub suggested_name: String,
    pub source: CopySource,
    pub content: TableContent,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableReadResult {
    pub file: TableFile,
    pub path: String,
    pub title: String,
    pub revision: u64,
    pub content_hash: String,
}
