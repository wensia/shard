/// `#标签` extraction and normalization, ported from `crates/shard-core/src/lib.rs`
/// (`normalize_tag`, `normalize_tags`, `normalize_type_tags`, `extract_tags`), which in
/// turn mirrors `packages/markdown/src/core/text.ts`. Change all three together; the
/// shared fixture file keeps them aligned.
///
/// Rust iterates `char`s, so everything here works on Unicode scalars, not Characters.
public enum ShardTags {
    public static let inbox = "inbox"
    public static let lockbox = "密匣"
    public static let typeTags = ["note", "outline", "flowchart", "document"]
    public static let protectedTypeTags = ["outline", "flowchart"]

    public static func normalizeTag(_ tag: String) -> String? {
        var scalars = trimmed(Array(tag.unicodeScalars), where: isWhitespace)
        while scalars.first == "#" {
            scalars.removeFirst()
        }
        scalars = trimmed(scalars, where: isTagEdgePunctuation)
        let normalized = words(scalars).joined(separator: " ")
        return normalized.isEmpty ? nil : normalized
    }

    /// Normalizes, optionally adds `inbox`, then sorts by UTF-8 bytes and removes duplicates.
    public static func normalizeTags(_ tags: [String], includeInbox: Bool) -> [String] {
        var next = tags.compactMap(normalizeTag)
        if includeInbox {
            next.append(inbox)
        }
        next.sort { $0.utf8.lexicographicallyPrecedes($1.utf8) }
        var unique: [String] = []
        for tag in next where unique.last.map({ !sameBytes($0, tag) }) ?? true {
            unique.append(tag)
        }
        return unique
    }

    public static func deriveType(_ tags: [String]) -> String? {
        typeTags.first { type in tags.contains { sameBytes($0, type) } }
    }

    /// Keeps at most one type tag: the first of `typeTags` that is present.
    public static func normalizeTypeTags(_ tags: [String]) -> [String] {
        let selected = deriveType(tags)
        return tags.filter { tag in
            !typeTags.contains { sameBytes($0, tag) } || selected.map { sameBytes($0, tag) } == true
        }
    }

    /// `#` must follow the start, whitespace, punctuation or a CJK character; the tag
    /// runs to the next whitespace or `#`, minus trailing punctuation.
    public static func extractTags(_ value: String) -> [String] {
        let scalars = Array(value.unicodeScalars)
        var tags: [String] = []
        for (index, scalar) in scalars.enumerated() where scalar == "#" {
            if index > 0, !isTagBoundary(scalars[index - 1]) {
                continue
            }
            var content = scalars[(index + 1)...].prefix { !isWhitespace($0) && $0 != "#" }
            while let last = content.last, isTrailingTagPunctuation(last) {
                content.removeLast()
            }
            if let tag = normalizeTag(string(content)), !tags.contains(where: { sameBytes($0, tag) }) {
                tags.append(tag)
            }
        }
        return tags
    }

    /// `#tag` spans exactly where `extractTags` finds tags (from `#` through the tag,
    /// trailing punctuation excluded), for highlighting like `getTagRanges` in text.ts.
    public static func tagRanges(in value: String) -> [Range<String.Index>] {
        let scalars = Array(value.unicodeScalars)
        let indices = Array(value.unicodeScalars.indices) + [value.unicodeScalars.endIndex]
        var ranges: [Range<String.Index>] = []
        for (index, scalar) in scalars.enumerated() where scalar == "#" {
            if index > 0, !isTagBoundary(scalars[index - 1]) {
                continue
            }
            var end = index + 1
            while end < scalars.count, !isWhitespace(scalars[end]), scalars[end] != "#" {
                end += 1
            }
            while end > index + 1, isTrailingTagPunctuation(scalars[end - 1]) {
                end -= 1
            }
            if normalizeTag(string(scalars[(index + 1)..<end])) != nil {
                ranges.append(indices[index]..<indices[end])
            }
        }
        return ranges
    }

    /// Tags written into a new fragment captured on iOS, following the desktop capture
    /// box: `inbox` plus extracted tags, minus `outline`/`flowchart` (those types are
    /// only created by their structured editors), then the backend normalization.
    public static func captureTags(for content: String) -> [String] {
        let extracted = extractTags(content).filter { tag in
            !protectedTypeTags.contains { sameBytes($0, tag) }
        }
        return normalizeTypeTags(normalizeTags(extracted, includeInbox: true))
    }

    public static func containsLockbox(_ tags: [String]) -> Bool {
        tags.contains { sameBytes($0, lockbox) }
    }

    // MARK: - Character classes (identical sets to shard-core)

    static func isWhitespace(_ scalar: Unicode.Scalar) -> Bool {
        scalar.properties.isWhitespace
    }

    private static let tagEdgePunctuation: Set<Unicode.Scalar> = [
        ",", ".", "?", "!", ";", ":", "，", "。", "？", "！", "；", "：", "、",
        ")", "]", "}", "\"", "'", "”", "’",
    ]

    private static let trailingTagPunctuation: Set<Unicode.Scalar> = [
        ")", ",", ".", "?", "!", ";", ":", "，", "。", "！", "？", "；", "：", "、",
        "]", "}", ">", "\"", "'", "”", "’",
    ]

    private static let tagBoundaryPunctuation: Set<Unicode.Scalar> = [
        "(", "[", "{", "<", "\"", "'", "“", "‘",
        "，", "。", "！", "？", "；", "：", "、", ",", ".", "!", "?", ";", ":",
    ]

    static func isTagEdgePunctuation(_ scalar: Unicode.Scalar) -> Bool {
        tagEdgePunctuation.contains(scalar)
    }

    static func isTrailingTagPunctuation(_ scalar: Unicode.Scalar) -> Bool {
        trailingTagPunctuation.contains(scalar)
    }

    static func isTagBoundary(_ scalar: Unicode.Scalar) -> Bool {
        isWhitespace(scalar) || tagBoundaryPunctuation.contains(scalar) || isCJKScript(scalar)
    }

    /// Same code point ranges as `is_cjk_script` (approximates Han/Hiragana/Katakana/Hangul).
    static func isCJKScript(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x2E80...0x2FDF, 0x3005, 0x3007, 0x3021...0x3029, 0x3038...0x303B,
             0x3040...0x309F, 0x30A0...0x30FF, 0x31F0...0x31FF, 0x3400...0x4DBF,
             0x4E00...0x9FFF, 0xF900...0xFAFF, 0x1100...0x11FF, 0x3130...0x318F,
             0xAC00...0xD7AF, 0xFF66...0xFF9F, 0x20000...0x3134F:
            true
        default:
            false
        }
    }

    // MARK: - Scalar helpers

    /// Rust compares strings by bytes; Swift's `==` uses canonical equivalence.
    static func sameBytes(_ lhs: String, _ rhs: String) -> Bool {
        lhs.utf8.elementsEqual(rhs.utf8)
    }

    private static func trimmed(
        _ scalars: [Unicode.Scalar],
        where predicate: (Unicode.Scalar) -> Bool
    ) -> [Unicode.Scalar] {
        guard let start = scalars.firstIndex(where: { !predicate($0) }),
              let end = scalars.lastIndex(where: { !predicate($0) })
        else { return [] }
        return Array(scalars[start...end])
    }

    /// `split_whitespace`: non-empty runs between whitespace.
    private static func words(_ scalars: [Unicode.Scalar]) -> [String] {
        scalars.split(whereSeparator: isWhitespace).map(string)
    }

    static func string<S: Sequence>(_ scalars: S) -> String where S.Element == Unicode.Scalar {
        var view = String.UnicodeScalarView()
        view.append(contentsOf: scalars)
        return String(view)
    }
}
