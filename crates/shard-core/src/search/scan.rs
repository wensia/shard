use std::cmp::Ordering;

use super::{
    normalize_search_text, MatchLocation, MatchedField, ParsedQuery, ProjectedDocument, ScanMatch,
    ScanResult, SearchProjectionBlock, SearchTextPart,
};

const TERM_FREQUENCY_CAP: usize = 8;
const PREVIEW_CHARACTERS: usize = 200;
const PREVIEW_CONTEXT_BEFORE: usize = 48;

#[derive(Debug)]
struct RankedMatch {
    hit: ScanMatch,
    tier: u8,
    title_coverage: usize,
    tag_coverage: usize,
    term_frequency: usize,
    modified_at: i64,
}

pub fn scan_exact(
    documents: &[ProjectedDocument],
    query: &ParsedQuery,
    limit: usize,
) -> ScanResult {
    scan_exact_filtered(documents, query, limit, |_| true)
}

pub fn scan_exact_filtered<F>(
    documents: &[ProjectedDocument],
    query: &ParsedQuery,
    limit: usize,
    include: F,
) -> ScanResult
where
    F: Fn(&ProjectedDocument) -> bool,
{
    if query.is_empty() {
        return ScanResult {
            matches: Vec::new(),
            total: 0,
        };
    }

    let mut ranked = documents
        .iter()
        .filter(|document| include(document))
        .filter_map(|document| rank_document(document, query))
        .collect::<Vec<_>>();
    ranked.sort_by(compare_ranked);
    let total = ranked.len();
    let matches = ranked
        .into_iter()
        .take(limit)
        .map(|ranked| ranked.hit)
        .collect();

    ScanResult { matches, total }
}

fn rank_document(document: &ProjectedDocument, query: &ParsedQuery) -> Option<RankedMatch> {
    let title_matches = query
        .terms
        .iter()
        .map(|term| document.normalized_title.contains(term))
        .collect::<Vec<_>>();
    let tag_matches = query
        .terms
        .iter()
        .map(|term| {
            document
                .normalized_tags
                .iter()
                .any(|tag| tag.contains(term))
        })
        .collect::<Vec<_>>();
    let body_matches = query
        .terms
        .iter()
        .map(|term| {
            document
                .normalized_blocks
                .iter()
                .any(|block| block.contains(term))
        })
        .collect::<Vec<_>>();

    if (0..query.terms.len())
        .any(|index| !title_matches[index] && !tag_matches[index] && !body_matches[index])
    {
        return None;
    }

    let title_coverage = title_matches.iter().filter(|matched| **matched).count();
    let tag_coverage = tag_matches.iter().filter(|matched| **matched).count();
    let tier = if title_coverage == query.terms.len() {
        0
    } else if (0..query.terms.len()).all(|index| title_matches[index] || tag_matches[index]) {
        1
    } else {
        2
    };

    let mut matched_fields = Vec::new();
    if title_matches.iter().any(|matched| *matched) {
        matched_fields.push(MatchedField::Title);
    }
    if tag_matches.iter().any(|matched| *matched) {
        matched_fields.push(MatchedField::Tags);
    }
    if body_matches.iter().any(|matched| *matched) {
        matched_fields.push(MatchedField::Body);
    }

    let revealable_body_block = document
        .projection
        .blocks
        .iter()
        .zip(&document.normalized_blocks)
        .find(|(block, normalized)| {
            matches!(block, SearchProjectionBlock::Text { .. })
                && query.terms.iter().any(|term| normalized.contains(term))
        });
    let body_block = revealable_body_block.or_else(|| {
        document
            .projection
            .blocks
            .iter()
            .zip(&document.normalized_blocks)
            .find(|(_, normalized)| query.terms.iter().any(|term| normalized.contains(term)))
    });
    let (preview, location) = match body_block {
        Some((block, _)) => (
            highlight_text(block.text(), &query.terms, Some(PREVIEW_CHARACTERS)),
            if matches!(block, SearchProjectionBlock::Text { .. }) {
                MatchLocation::Text
            } else {
                MatchLocation::DocumentOnly
            },
        ),
        None => (Vec::new(), MatchLocation::Metadata),
    };

    let term_frequency = query
        .terms
        .iter()
        .map(|term| {
            let count = count_occurrences(&document.normalized_title, term)
                + document
                    .normalized_tags
                    .iter()
                    .map(|tag| count_occurrences(tag, term))
                    .sum::<usize>()
                + document
                    .normalized_blocks
                    .iter()
                    .map(|block| count_occurrences(block, term))
                    .sum::<usize>();
            count.min(TERM_FREQUENCY_CAP)
        })
        .sum();

    Some(RankedMatch {
        hit: ScanMatch {
            stable_key: document.stable_key.clone(),
            matched_fields,
            title_parts: highlight_text(&document.title, &query.terms, None),
            preview,
            location,
        },
        tier,
        title_coverage,
        tag_coverage,
        term_frequency,
        modified_at: document.modified_at,
    })
}

fn compare_ranked(left: &RankedMatch, right: &RankedMatch) -> Ordering {
    left.tier
        .cmp(&right.tier)
        .then_with(|| right.title_coverage.cmp(&left.title_coverage))
        .then_with(|| right.tag_coverage.cmp(&left.tag_coverage))
        .then_with(|| right.term_frequency.cmp(&left.term_frequency))
        .then_with(|| right.modified_at.cmp(&left.modified_at))
        .then_with(|| left.hit.stable_key.cmp(&right.hit.stable_key))
}

fn count_occurrences(text: &str, term: &str) -> usize {
    if term.is_empty() {
        return 0;
    }
    text.match_indices(term).count()
}

#[derive(Debug)]
struct MappedText {
    normalized: Vec<char>,
    original: Vec<String>,
}

fn mapped_text(text: &str) -> MappedText {
    let mut normalized = Vec::new();
    let mut original = Vec::new();
    let mut chars = text.chars().peekable();

    while let Some(character) = chars.next() {
        if character == '\r' {
            let mut source = String::from("\r");
            if chars.peek() == Some(&'\n') {
                chars.next();
                source.push('\n');
            }
            normalized.push('\n');
            original.push(source);
            continue;
        }
        let folded = normalize_search_text(&character.to_string());
        normalized.push(folded.chars().next().unwrap_or(character));
        original.push(character.to_string());
    }

    MappedText {
        normalized,
        original,
    }
}

fn highlight_text(text: &str, terms: &[String], limit: Option<usize>) -> Vec<SearchTextPart> {
    let mapped = mapped_text(text);
    let mut ranges = Vec::new();
    for term in terms {
        let needle = term.chars().collect::<Vec<_>>();
        if needle.is_empty() || needle.len() > mapped.normalized.len() {
            continue;
        }
        for start in 0..=mapped.normalized.len() - needle.len() {
            if mapped.normalized[start..start + needle.len()] == needle {
                ranges.push((start, start + needle.len()));
            }
        }
    }
    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for range in ranges {
        if let Some(previous) = merged.last_mut() {
            if range.0 <= previous.1 {
                previous.1 = previous.1.max(range.1);
                continue;
            }
        }
        merged.push(range);
    }

    let (start, end) = match (limit, merged.first()) {
        (Some(maximum), Some(first)) if mapped.original.len() > maximum => {
            let mut start = first.0.saturating_sub(PREVIEW_CONTEXT_BEFORE);
            let end = (start + maximum).min(mapped.original.len());
            if end == mapped.original.len() {
                start = end.saturating_sub(maximum);
            }
            (start, end)
        }
        _ => (0, mapped.original.len()),
    };

    let mut parts = Vec::new();
    if start > 0 {
        push_part(&mut parts, "…", false);
    }
    for index in start..end {
        let hit = merged
            .iter()
            .any(|(range_start, range_end)| index >= *range_start && index < *range_end);
        push_part(&mut parts, &mapped.original[index], hit);
    }
    if end < mapped.original.len() {
        push_part(&mut parts, "…", false);
    }
    parts
}

fn push_part(parts: &mut Vec<SearchTextPart>, text: &str, hit: bool) {
    if let Some(previous) = parts.last_mut() {
        if previous.hit == hit {
            previous.text.push_str(text);
            return;
        }
    }
    parts.push(SearchTextPart {
        text: text.to_string(),
        hit,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::{project_document, SourceDocument};

    fn document(
        stable_key: &str,
        title: &str,
        tags: &[&str],
        body: &str,
        modified_at: i64,
    ) -> ProjectedDocument {
        project_document(&SourceDocument {
            stable_key: stable_key.to_string(),
            title: title.to_string(),
            tags: tags.iter().map(|tag| (*tag).to_string()).collect(),
            body: body.to_string(),
            modified_at,
        })
    }

    #[test]
    fn search_query_matches_terms_across_fields() {
        let documents = vec![document("跨字段", "Alpha", &["计划"], "正文有搜索", 1)];
        let result = scan_exact(
            &documents,
            &ParsedQuery::parse("alpha 计划 搜索").unwrap(),
            10,
        );
        assert_eq!(result.total, 1);
        assert_eq!(
            result.matches[0].matched_fields,
            vec![MatchedField::Title, MatchedField::Tags, MatchedField::Body]
        );
    }

    #[test]
    fn search_ascii_infix_matches_without_word_boundary() {
        let documents = vec![document("infix", "普通标题", &[], "prefixSearchSuffix", 1)];
        let result = scan_exact(&documents, &ParsedQuery::parse("search").unwrap(), 10);
        assert_eq!(result.total, 1);
        assert!(result.matches[0]
            .preview
            .iter()
            .any(|part| part.hit && part.text == "Search"));
    }

    #[test]
    fn search_exact_validation_precedes_top_k() {
        let documents = vec![
            document("00-no-match", "无关", &[], "无关正文", 100),
            document("01-body", "Alpha", &[], "正文搜索", 1),
            document("02-title", "Alpha 搜索", &[], "普通正文", 0),
        ];
        let result = scan_exact(&documents, &ParsedQuery::parse("alpha 搜索").unwrap(), 1);
        assert_eq!(result.total, 2);
        assert_eq!(result.matches[0].stable_key, "02-title");
    }

    #[test]
    fn search_filter_applies_before_total_and_top_k() {
        let documents = vec![
            document("00-excluded", "Alpha 搜索", &[], "正文", 100),
            document("01-included", "Alpha", &[], "正文搜索", 1),
        ];
        let result = scan_exact_filtered(
            &documents,
            &ParsedQuery::parse("alpha 搜索").unwrap(),
            1,
            |document| document.stable_key != "00-excluded",
        );

        assert_eq!(result.total, 1);
        assert_eq!(result.matches[0].stable_key, "01-included");
    }

    #[test]
    fn search_ranking_uses_coverage_capped_frequency_mtime_and_stable_key() {
        let documents = vec![
            document("01-title", "alpha", &[], "beta", 0),
            document("02-tag", "普通标题", &["alpha"], "beta", 0),
            document(
                "03-balanced",
                "普通标题",
                &[],
                "alpha alpha alpha alpha alpha alpha alpha alpha beta beta",
                0,
            ),
            document(
                "04-capped",
                "普通标题",
                &[],
                &format!("{} beta", "alpha ".repeat(20)),
                100,
            ),
            document("05-newer", "普通标题", &[], "alpha beta", 2),
            document("06-stable-a", "普通标题", &[], "alpha beta", 1),
            document("07-stable-b", "普通标题", &[], "alpha beta", 1),
        ];
        let result = scan_exact(
            &documents,
            &ParsedQuery::parse("alpha beta").unwrap(),
            documents.len(),
        );
        assert_eq!(
            result
                .matches
                .iter()
                .map(|hit| hit.stable_key.as_str())
                .collect::<Vec<_>>(),
            vec![
                "01-title",
                "02-tag",
                "03-balanced",
                "04-capped",
                "05-newer",
                "06-stable-a",
                "07-stable-b",
            ]
        );
    }

    #[test]
    fn search_metadata_match_is_document_only() {
        let documents = vec![document("metadata", "元数据命中", &[], "普通正文", 1)];
        let result = scan_exact(&documents, &ParsedQuery::parse("元数据").unwrap(), 10);
        assert_eq!(result.matches[0].location, MatchLocation::Metadata);
        assert!(result.matches[0].preview.is_empty());
    }

    #[test]
    fn search_document_only_body_match_is_not_revealable() {
        let documents = vec![document(
            "fence",
            "普通标题",
            &[],
            "```ts\nconst hidden_value = 1\n```",
            1,
        )];
        let result = scan_exact(&documents, &ParsedQuery::parse("hidden_value").unwrap(), 10);
        assert_eq!(result.matches[0].location, MatchLocation::DocumentOnly);
    }

    #[test]
    fn search_revealable_match_is_preferred_over_an_earlier_fence_match() {
        let documents = vec![document(
            "mixed",
            "普通标题",
            &[],
            "```ts\nsearch_here()\n```\n正文也有 search_here",
            1,
        )];
        let result = scan_exact(&documents, &ParsedQuery::parse("search_here").unwrap(), 10);
        assert_eq!(result.matches[0].location, MatchLocation::Text);
        assert_eq!(
            result.matches[0]
                .preview
                .iter()
                .map(|part| part.text.as_str())
                .collect::<String>(),
            "正文也有 search_here"
        );
    }

    #[test]
    fn search_title_parts_preserve_original_unicode_without_offsets() {
        let documents = vec![document("fullwidth", "ＦＯＯ 😀", &[], "正文", 1)];
        let result = scan_exact(&documents, &ParsedQuery::parse("foo").unwrap(), 10);
        assert_eq!(
            result.matches[0]
                .title_parts
                .iter()
                .map(|part| part.text.as_str())
                .collect::<String>(),
            "ＦＯＯ 😀"
        );
        assert_eq!(result.matches[0].title_parts[0].text, "ＦＯＯ");
        assert!(result.matches[0].title_parts[0].hit);
    }
}
