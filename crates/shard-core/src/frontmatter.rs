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
    let mut chars = candidate.chars();
    let first = chars.next()?;
    if !(first.is_ascii_alphabetic() || first == '_')
        || !chars.all(|character| character.is_ascii_alphanumeric() || character == '_')
    {
        return None;
    }
    Some(candidate.to_string())
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
