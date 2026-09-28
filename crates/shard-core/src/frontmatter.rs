use crate::{write_text_atomically, FragmentFrontmatter};
use serde_yaml::{Mapping, Value};
use std::path::Path;

pub const SYSTEM_KEYS: [&str; 10] = [
    "id",
    "created_at",
    "updated_at",
    "tags",
    "category",
    "ai_status",
    "pinned",
    "source",
    "conflict_of",
    "related",
];

#[derive(Debug, Clone)]
pub struct ParsedFragment {
    pub raw: String,
    pub frontmatter: FragmentFrontmatter,
    pub body: String,
}

#[derive(Debug, Clone)]
struct RawItem {
    key: Option<String>,
    text: String,
}

#[derive(Debug, Clone)]
pub struct CustomPropertyEntry {
    pub key: String,
    pub value: Option<Value>,
    pub raw: String,
    pub editable: bool,
}

pub fn parse_fragment(text: &str) -> Result<ParsedFragment, String> {
    let rest = text
        .strip_prefix("---\n")
        .ok_or_else(|| "片段缺少 frontmatter".to_string())?;
    let boundary = rest
        .find("\n---")
        .ok_or_else(|| "片段 frontmatter 未闭合".to_string())?;
    let raw = &rest[..boundary];
    let body = &rest[(boundary + 4)..];
    let frontmatter =
        serde_yaml::from_str::<FragmentFrontmatter>(raw).map_err(|error| error.to_string())?;
    Ok(ParsedFragment {
        raw: raw.to_string(),
        frontmatter,
        body: body.to_string(),
    })
}

pub fn apply_frontmatter(raw: &str, next: &FragmentFrontmatter) -> Result<String, String> {
    let old = parse_mapping(raw)?;
    let want = frontmatter_mapping(next)?;
    let mut items = split_raw_items(raw);
    validate_system_entries(&old, &items)?;

    for key in SYSTEM_KEYS {
        let yaml_key = Value::String(key.to_string());
        let old_value = old.get(&yaml_key);
        let want_value = want.get(&yaml_key);
        if old_value == want_value {
            continue;
        }

        let matching = items
            .iter()
            .enumerate()
            .filter_map(|(index, item)| (item.key.as_deref() == Some(key)).then_some(index))
            .collect::<Vec<_>>();
        match want_value {
            Some(value) => {
                let replacement = RawItem {
                    key: Some(key.to_string()),
                    text: serialize_entry(key, value)?,
                };
                if let Some(index) = matching.first().copied() {
                    items[index] = replacement;
                } else {
                    let index = insertion_index(&items, key);
                    items.insert(index, replacement);
                }
            }
            None => {
                if let Some(index) = matching.first().copied() {
                    items.remove(index);
                }
            }
        }
    }

    let updated = items
        .iter()
        .map(|item| item.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    validate_updated_mapping(&old, &want, &updated, next)?;
    Ok(updated)
}

pub fn validate_property_key(key: &str) -> Result<(), String> {
    let length = key.chars().count();
    if length == 0 {
        return Err("属性名不能为空。".to_string());
    }
    if length > 64 {
        return Err("属性名不能超过 64 个字符。".to_string());
    }
    if key.starts_with('-')
        || !key
            .chars()
            .all(|character| character.is_alphanumeric() || matches!(character, '_' | '-'))
    {
        return Err("属性名只能包含字母、数字、下划线和连字符，且不能以连字符开头。".to_string());
    }
    if SYSTEM_KEYS.contains(&key) {
        return Err(format!("{key} 是系统保留属性名。"));
    }
    Ok(())
}

pub fn set_custom_property(raw: &str, key: &str, value: &Value) -> Result<String, String> {
    validate_property_key(key)?;
    let mut items = split_raw_items(raw);
    let matching = matching_property_items(&items, key);
    if matching.len() > 1 {
        return Err(format!("属性 {key} 重复，无法安全修改。"));
    }

    let replacement = RawItem {
        key: Some(key.to_string()),
        text: serialize_property_entry(key, value)?,
    };
    let updated = if let Some(index) = matching.first().copied() {
        if items[index].key.as_deref() != Some(key) {
            return Err(format!("属性 {key} 的写法无法安全定位。"));
        }
        reject_referenced_item_anchors(&items, index, key)?;
        items[index] = replacement;
        items
            .iter()
            .map(|item| item.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        let index = items
            .iter()
            .rposition(|item| !item.text.is_empty())
            .map(|index| index + 1)
            .unwrap_or(0);
        items.insert(index, replacement);
        items
            .iter()
            .map(|item| item.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    };

    validate_custom_property_update(raw, &updated, key, Some(value))?;
    Ok(updated)
}

pub fn remove_custom_property(raw: &str, key: &str) -> Result<String, String> {
    validate_property_key(key)?;
    let mut items = split_raw_items(raw);
    let matching = matching_property_items(&items, key);
    if matching.len() > 1 {
        return Err(format!("属性 {key} 重复，无法安全删除。"));
    }
    let Some(index) = matching.first().copied() else {
        return Ok(raw.to_string());
    };
    if items[index].key.as_deref() != Some(key) {
        return Err(format!("属性 {key} 的写法无法安全定位。"));
    }
    reject_referenced_item_anchors(&items, index, key)?;
    items.remove(index);
    let updated = items
        .iter()
        .map(|item| item.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    validate_custom_property_update(raw, &updated, key, None)?;
    Ok(updated)
}

pub fn custom_property_entries(raw: &str) -> Vec<CustomPropertyEntry> {
    let items = split_raw_items(raw);
    let keys = items.iter().map(item_property_keys).collect::<Vec<_>>();
    let mut entries = Vec::new();
    for (index, item) in items.iter().enumerate() {
        for key in &keys[index] {
            if SYSTEM_KEYS.contains(&key.as_str()) {
                continue;
            }
            let occurrences = keys
                .iter()
                .flatten()
                .filter(|candidate| *candidate == key)
                .count();
            let value = item_property_value(item, key);
            entries.push(CustomPropertyEntry {
                key: key.clone(),
                value,
                raw: item.text.clone(),
                editable: occurrences == 1 && item.key.as_deref() == Some(key.as_str()),
            });
        }
    }
    entries
}

pub fn render_fragment(raw: &str, body: &str) -> String {
    format!("---\n{raw}\n---\n\n{}\n", body.trim_end())
}

pub fn write_fragment_update(
    path: &Path,
    raw: &str,
    next: &FragmentFrontmatter,
    body: &str,
) -> Result<(), String> {
    let raw = apply_frontmatter(raw, next)?;
    write_text_atomically(path, &render_fragment(&raw, body))
}

pub fn raw_from_frontmatter(frontmatter: &FragmentFrontmatter) -> Result<String, String> {
    let yaml = serde_yaml::to_string(frontmatter).map_err(|error| error.to_string())?;
    Ok(yaml
        .strip_prefix("---\n")
        .unwrap_or(&yaml)
        .trim_end_matches('\n')
        .to_string())
}

fn parse_mapping(raw: &str) -> Result<Mapping, String> {
    match serde_yaml::from_str::<Value>(raw).map_err(|error| error.to_string())? {
        Value::Mapping(mapping) => Ok(mapping),
        _ => Err("片段 frontmatter 必须是映射。".to_string()),
    }
}

fn frontmatter_mapping(frontmatter: &FragmentFrontmatter) -> Result<Mapping, String> {
    match serde_yaml::to_value(frontmatter).map_err(|error| error.to_string())? {
        Value::Mapping(mapping) => Ok(mapping),
        _ => Err("片段 frontmatter 必须是映射。".to_string()),
    }
}

fn split_raw_items(raw: &str) -> Vec<RawItem> {
    let mut items = Vec::<RawItem>::new();
    for line in raw.split('\n') {
        let is_misc = line.is_empty() || line.starts_with('#');
        let starts_item = !is_misc
            && !line.starts_with('-')
            && line
                .as_bytes()
                .first()
                .is_some_and(|byte| !byte.is_ascii_whitespace());
        if starts_item || is_misc || items.is_empty() {
            items.push(RawItem {
                key: starts_item.then(|| recognized_key(line)).flatten(),
                text: line.to_string(),
            });
        } else if let Some(item) = items.last_mut() {
            item.text.push('\n');
            item.text.push_str(line);
        }
    }
    items
}

fn recognized_key(line: &str) -> Option<String> {
    let colon = line.find(':')?;
    let candidate = line[..colon].trim_end_matches(|character: char| character.is_whitespace());
    if candidate.is_empty() || line[..colon].len() == 0 {
        return None;
    }
    if !line[(colon + 1)..]
        .chars()
        .next()
        .is_none_or(|character| character.is_whitespace())
    {
        return None;
    }
    if candidate.starts_with('-')
        || !candidate
            .chars()
            .all(|character| character.is_alphanumeric() || matches!(character, '_' | '-'))
    {
        return None;
    }
    Some(candidate.to_string())
}

fn item_property_keys(item: &RawItem) -> Vec<String> {
    if let Some(key) = &item.key {
        return vec![key.clone()];
    }
    let Ok(Value::Mapping(mapping)) = serde_yaml::from_str::<Value>(&item.text) else {
        return Vec::new();
    };
    mapping
        .keys()
        .filter_map(|key| match key {
            Value::String(key) => Some(key.clone()),
            _ => None,
        })
        .collect()
}

fn item_property_value(item: &RawItem, key: &str) -> Option<Value> {
    let Value::Mapping(mapping) = serde_yaml::from_str::<Value>(&item.text).ok()? else {
        return None;
    };
    if item.key.as_deref() == Some(key) && mapping.len() == 1 {
        return mapping.values().next().cloned();
    }
    mapping.get(Value::String(key.to_string())).cloned()
}

fn matching_property_items(items: &[RawItem], key: &str) -> Vec<usize> {
    items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            item_property_keys(item)
                .iter()
                .any(|item_key| item_key == key)
                .then_some(index)
        })
        .collect()
}

fn reject_referenced_item_anchors(
    items: &[RawItem],
    target_index: usize,
    key: &str,
) -> Result<(), String> {
    for anchor in yaml_tokens(&items[target_index].text, '&') {
        if items.iter().enumerate().any(|(index, item)| {
            index != target_index && contains_yaml_token(&item.text, '*', &anchor)
        }) {
            return Err(format!("属性 {key} 被 YAML 别名引用，无法安全修改。"));
        }
    }
    Ok(())
}

fn serialize_property_entry(key: &str, value: &Value) -> Result<String, String> {
    const PLACEHOLDER: &str = "shard_property_placeholder";
    let serialized = serialize_entry(PLACEHOLDER, value)?;
    let prefix = format!("{PLACEHOLDER}:");
    let rest = serialized
        .strip_prefix(&prefix)
        .ok_or_else(|| "属性序列化失败。".to_string())?;
    Ok(format!("{key}:{rest}"))
}

fn validate_custom_property_update(
    old: &str,
    updated: &str,
    key: &str,
    expected: Option<&Value>,
) -> Result<(), String> {
    let old_items = split_raw_items(old);
    let new_items = split_raw_items(updated);
    let old_other = old_items
        .iter()
        .filter(|item| {
            !item_property_keys(item)
                .iter()
                .any(|candidate| candidate == key)
        })
        .map(|item| item.text.as_str())
        .collect::<Vec<_>>();
    let new_other = new_items
        .iter()
        .filter(|item| {
            !item_property_keys(item)
                .iter()
                .any(|candidate| candidate == key)
        })
        .map(|item| item.text.as_str())
        .collect::<Vec<_>>();
    if old_other != new_other {
        return Err("其它 frontmatter 条目在属性改写后发生变化。".to_string());
    }

    let matching = matching_property_items(&new_items, key);
    match expected {
        Some(expected) if matching.len() == 1 => {
            if item_property_value(&new_items[matching[0]], key).as_ref() != Some(expected) {
                return Err(format!("属性 {key} 写后校验失败。"));
            }
        }
        Some(_) => return Err(format!("属性 {key} 写后校验失败。")),
        None if !matching.is_empty() => return Err(format!("属性 {key} 删除校验失败。")),
        None => {}
    }
    Ok(())
}

fn validate_system_entries(old: &Mapping, items: &[RawItem]) -> Result<(), String> {
    for key in SYSTEM_KEYS {
        let count = items
            .iter()
            .filter(|item| item.key.as_deref() == Some(key))
            .count();
        let exists = old.contains_key(Value::String(key.to_string()));
        if count != usize::from(exists) {
            return Err(format!("无法安全局部改写系统键 {key}。"));
        }
    }
    reject_referenced_system_anchors(items)
}

fn reject_referenced_system_anchors(items: &[RawItem]) -> Result<(), String> {
    for item in items {
        let Some(key) = item.key.as_deref() else {
            continue;
        };
        if !SYSTEM_KEYS.contains(&key) {
            continue;
        }
        for anchor in yaml_tokens(&item.text, '&') {
            if items.iter().any(|candidate| {
                !std::ptr::eq(candidate, item) && contains_yaml_token(&candidate.text, '*', &anchor)
            }) {
                return Err(format!("系统键 {key} 被 YAML 别名引用，无法安全局部改写。"));
            }
        }
    }
    Ok(())
}

fn yaml_tokens(text: &str, marker: char) -> Vec<String> {
    let chars = text.chars().collect::<Vec<_>>();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == marker
            && (index == 0
                || chars[index - 1].is_whitespace()
                || matches!(chars[index - 1], ':' | '[' | ',' | '-'))
        {
            let start = index + 1;
            let mut end = start;
            while end < chars.len()
                && (chars[end].is_ascii_alphanumeric() || matches!(chars[end], '_' | '-'))
            {
                end += 1;
            }
            if end > start {
                tokens.push(chars[start..end].iter().collect());
            }
            index = end;
        } else {
            index += 1;
        }
    }
    tokens
}

fn contains_yaml_token(text: &str, marker: char, name: &str) -> bool {
    yaml_tokens(text, marker).iter().any(|token| token == name)
}

fn serialize_entry(key: &str, value: &Value) -> Result<String, String> {
    let mut mapping = Mapping::new();
    mapping.insert(Value::String(key.to_string()), value.clone());
    let yaml = serde_yaml::to_string(&mapping).map_err(|error| error.to_string())?;
    Ok(yaml
        .strip_prefix("---\n")
        .unwrap_or(&yaml)
        .trim_end_matches('\n')
        .to_string())
}

fn insertion_index(items: &[RawItem], key: &str) -> usize {
    let order = SYSTEM_KEYS
        .iter()
        .position(|candidate| *candidate == key)
        .unwrap();
    for later in &SYSTEM_KEYS[(order + 1)..] {
        if let Some(index) = items
            .iter()
            .position(|item| item.key.as_deref() == Some(*later))
        {
            return index;
        }
    }
    for earlier in SYSTEM_KEYS[..order].iter().rev() {
        if let Some(index) = items
            .iter()
            .rposition(|item| item.key.as_deref() == Some(*earlier))
        {
            return index + 1;
        }
    }
    items.len()
}

fn validate_updated_mapping(
    old: &Mapping,
    want: &Mapping,
    updated: &str,
    next: &FragmentFrontmatter,
) -> Result<(), String> {
    let new = parse_mapping(updated)?;
    let mut old_custom = old.clone();
    let mut new_custom = new.clone();
    for key in SYSTEM_KEYS {
        let yaml_key = Value::String(key.to_string());
        old_custom.remove(&yaml_key);
        new_custom.remove(&yaml_key);
        if new.get(&yaml_key) != want.get(&yaml_key) {
            return Err(format!("系统键 {key} 局部改写校验失败。"));
        }
    }
    if old_custom != new_custom {
        return Err("未知 frontmatter 在局部改写后发生变化。".to_string());
    }
    let parsed =
        serde_yaml::from_str::<FragmentFrontmatter>(updated).map_err(|error| error.to_string())?;
    if serde_yaml::to_value(parsed).map_err(|error| error.to_string())?
        != serde_yaml::to_value(next).map_err(|error| error.to_string())?
    {
        return Err("frontmatter 投影与目标值不一致。".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{write_fragment_file, FragmentRelation};
    use std::fs;

    fn sample_frontmatter() -> FragmentFrontmatter {
        FragmentFrontmatter {
            id: "fragment-1".to_string(),
            created_at: "2026-09-28T08:00:00+08:00".to_string(),
            updated_at: "2026-09-28T08:00:00+08:00".to_string(),
            tags: vec!["inbox".to_string()],
            category: None,
            ai_status: Some("none".to_string()),
            pinned: false,
            source: "test".to_string(),
            conflict_of: None,
            related: Vec::new(),
        }
    }

    fn relation(index: usize, with_note: bool) -> FragmentRelation {
        FragmentRelation {
            target_id: format!("target-{index}"),
            origin: "manual".to_string(),
            created_at: format!("2026-09-28T08:0{index}:00+08:00"),
            note: with_note.then(|| format!("note-{index}")),
        }
    }

    fn legacy_render(frontmatter: &FragmentFrontmatter, body: &str) -> String {
        let tempdir = tempfile::tempdir().unwrap();
        let path = tempdir.path().join("fragment.md");
        write_fragment_file(&path, frontmatter, body).unwrap();
        fs::read_to_string(path).unwrap()
    }

    #[test]
    fn canonical_updates_match_legacy_writer_bytes() {
        for pinned in [false, true] {
            for related_count in 0..=2 {
                for with_note in [false, true] {
                    for conflict in [false, true] {
                        for optional_values in [false, true] {
                            let mut current = sample_frontmatter();
                            current.pinned = pinned;
                            current.related = (0..related_count)
                                .map(|index| relation(index, with_note))
                                .collect();
                            current.conflict_of = conflict.then(|| "conflict-source".to_string());
                            if optional_values {
                                current.category = Some("research".to_string());
                                current.ai_status = None;
                            }
                            let mut raw = raw_from_frontmatter(&current).unwrap();
                            for step in 0..4 {
                                let mut next = current.clone();
                                match step {
                                    0 => next.tags = vec!["alpha".into(), "beta".into()],
                                    1 => next.updated_at = "2026-09-28T09:30:00+08:00".to_string(),
                                    2 => next.pinned = !next.pinned,
                                    _ if next.related.is_empty() => {
                                        next.related.push(relation(9, true));
                                    }
                                    _ => next.related.clear(),
                                }
                                raw = apply_frontmatter(&raw, &next).unwrap();
                                assert_eq!(
                                    render_fragment(&raw, "body\n"),
                                    legacy_render(&next, "body\n")
                                );
                                current = next;
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn preserves_unknown_entries_byte_for_byte() {
        let raw = r#"# 顶部注释
author: 张三
id: fragment-1
created_at: 2026-09-28T08:00:00+08:00
rating: 5 # 行尾注释
updated_at: 2026-09-28T08:00:00+08:00
tags: [inbox]
category: null
custom_list:
  - first
  - second

ai_status: none
source: test
isbn: '00123'
nested:
  enabled: true
  count: 2
description: |
  第一行
  第二行
# 尾部注释"#;
        let custom_chunks = [
            "# 顶部注释\nauthor: 张三\n",
            "rating: 5 # 行尾注释",
            "custom_list:\n  - first\n  - second\n\n",
            "isbn: '00123'",
            "nested:\n  enabled: true\n  count: 2",
            "description: |\n  第一行\n  第二行\n# 尾部注释",
        ];
        let mut current = serde_yaml::from_str::<FragmentFrontmatter>(raw).unwrap();
        let mut updated = raw.to_string();
        current.tags = vec!["alpha".into(), "beta".into()];
        updated = apply_frontmatter(&updated, &current).unwrap();
        current.pinned = true;
        updated = apply_frontmatter(&updated, &current).unwrap();
        current.related.push(relation(1, false));
        updated = apply_frontmatter(&updated, &current).unwrap();
        current.related.clear();
        updated = apply_frontmatter(&updated, &current).unwrap();
        for chunk in custom_chunks {
            assert!(updated.contains(chunk), "missing preserved chunk: {chunk}");
        }
    }

    #[test]
    fn rewrites_only_changed_system_key() {
        let raw = r#"id: fragment-1
created_at: 2026-09-28T08:00:00+08:00
updated_at: 2026-09-28T08:00:00+08:00
tags: [a, b]
category: null
ai_status: none
source: test"#;
        let mut next = serde_yaml::from_str::<FragmentFrontmatter>(raw).unwrap();
        next.pinned = true;
        let pinned = apply_frontmatter(raw, &next).unwrap();
        assert!(pinned.contains("tags: [a, b]"));
        assert_eq!(pinned.replace("pinned: true\n", ""), raw);

        next.tags = vec!["changed".to_string()];
        let changed = apply_frontmatter(&pinned, &next).unwrap();
        assert_eq!(changed.matches("tags:").count(), 1);
        assert!(!changed.contains("tags: [a, b]"));
        assert_eq!(changed.replace("tags:\n- changed", "tags: [a, b]"), pinned);
    }

    #[test]
    fn inserts_missing_system_keys_in_canonical_order() {
        let current = sample_frontmatter();
        let raw = raw_from_frontmatter(&current).unwrap();
        assert!(!raw.contains("pinned:"));
        assert!(!raw.contains("conflict_of:"));
        assert!(!raw.contains("related:"));

        let mut next = current;
        next.pinned = true;
        next.conflict_of = Some("original".to_string());
        next.related = vec![relation(1, true)];
        assert_eq!(
            apply_frontmatter(&raw, &next).unwrap(),
            raw_from_frontmatter(&next).unwrap()
        );
    }

    #[test]
    fn rejects_unsafe_system_key_layouts() {
        let canonical = raw_from_frontmatter(&sample_frontmatter()).unwrap();
        let quoted = canonical.replacen("tags:", "\"tags\":", 1);
        assert!(apply_frontmatter(&quoted, &sample_frontmatter()).is_err());

        let duplicate =
            canonical.replacen("tags:\n- inbox", "tags:\n- inbox\ntags:\n- duplicate", 1);
        assert!(apply_frontmatter(&duplicate, &sample_frontmatter()).is_err());

        let anchored = canonical.replacen(
            "tags:\n- inbox",
            "tags: &shared\n- inbox\nmirror: *shared",
            1,
        );
        assert!(apply_frontmatter(&anchored, &sample_frontmatter()).is_err());
    }

    #[test]
    fn custom_properties_set_replace_remove_and_preserve_other_bytes() {
        let raw = format!(
            "{}\n# 自定义注释\n作者: 张三\n评分: 5 # 保留行尾\n说明: |\n  第一行\n  第二行\n",
            raw_from_frontmatter(&sample_frontmatter()).unwrap()
        );
        let before_system = raw_from_frontmatter(&sample_frontmatter()).unwrap();

        let added = set_custom_property(&raw, "项目-阶段", &Value::String("验证".into())).unwrap();
        assert!(added.contains("项目-阶段: 验证"));
        assert!(added.contains("评分: 5 # 保留行尾"));
        assert!(added.contains("说明: |\n  第一行\n  第二行"));
        assert!(added.contains(&before_system));

        let replaced = set_custom_property(&added, "作者", &Value::String("李四".into())).unwrap();
        assert!(replaced.contains("作者: 李四"));
        assert!(!replaced.contains("作者: 张三"));
        assert!(replaced.contains("评分: 5 # 保留行尾"));

        let removed = remove_custom_property(&replaced, "项目-阶段").unwrap();
        assert!(!removed.contains("项目-阶段:"));
        assert_eq!(remove_custom_property(&removed, "不存在").unwrap(), removed);

        let numeric =
            set_custom_property(&removed, "123", &Value::String("数字键".into())).unwrap();
        let document = format!("---\n{numeric}\n---\n正文");
        assert!(parse_fragment(&document).is_ok());
    }

    #[test]
    fn custom_properties_reject_unsafe_keys_layouts_and_referenced_anchors() {
        for key in ["", "-bad", "bad key", "bad.dot", "id"] {
            assert!(
                validate_property_key(key).is_err(),
                "key should fail: {key}"
            );
        }
        assert!(validate_property_key(&"字".repeat(65)).is_err());
        for key in ["作者", "项目-阶段", "123", "_内部"] {
            assert!(validate_property_key(key).is_ok(), "key should pass: {key}");
        }

        let quoted = "\"作者\": 张三";
        assert!(set_custom_property(quoted, "作者", &Value::String("李四".into())).is_err());
        let flow = "{作者: 张三, 评分: 5}";
        assert!(remove_custom_property(flow, "作者").is_err());
        let duplicate = "作者: 张三\n作者: 李四";
        assert!(set_custom_property(duplicate, "作者", &Value::String("王五".into())).is_err());
        let anchored = "作者: &shared 张三\n镜像: *shared";
        assert!(remove_custom_property(anchored, "作者").is_err());
    }

    #[test]
    fn custom_property_values_roundtrip_without_scalar_type_drift() {
        let cases = vec![
            ("文本", Value::String("00123".into())),
            ("链接", Value::String("[[目标]]".into())),
            ("数字", serde_yaml::from_str::<Value>("1.50").unwrap()),
            ("勾选", Value::Bool(true)),
            ("空值", Value::Null),
            (
                "列表",
                Value::Sequence(vec![Value::String("甲".into()), Value::String("2".into())]),
            ),
        ];
        let mut raw = raw_from_frontmatter(&sample_frontmatter()).unwrap();
        for (key, value) in &cases {
            raw = set_custom_property(&raw, key, value).unwrap();
        }
        let entries = custom_property_entries(&raw);
        for (key, value) in cases {
            let entry = entries.iter().find(|entry| entry.key == key).unwrap();
            assert_eq!(entry.value.as_ref(), Some(&value));
            assert!(entry.editable);
        }
        assert!(raw.contains("文本: '00123'"));
        assert!(raw.contains("链接: '[[目标]]'"));
    }

    #[test]
    fn parse_fragment_preserves_existing_body_boundaries() {
        let raw = raw_from_frontmatter(&sample_frontmatter()).unwrap();
        for body in ["\n\nbody\n", "body", "\n\nbody  \n\n"] {
            let text = format!("---\n{raw}\n---{body}");
            let parsed = parse_fragment(&text).unwrap();
            assert_eq!(parsed.raw, raw);
            assert_eq!(parsed.body, body);
        }
        assert_eq!(
            parse_fragment("body only").unwrap_err(),
            "片段缺少 frontmatter"
        );
        assert_eq!(
            parse_fragment("---\nid: open").unwrap_err(),
            "片段 frontmatter 未闭合"
        );
    }
}
