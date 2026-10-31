import Foundation

/// In-memory views over the mirrored vault: timeline, tags, notes and search.
public struct VaultIndex: Sendable {
    public struct TagCount: Hashable, Sendable, Identifiable {
        public var id: String { name }
        public let name: String
        public let count: Int
    }

    /// Pinned first, then newest `created_at` first — the desktop's `list_fragments` order.
    public let fragments: [VaultDocument]
    /// Notes ordered by path, so folders stay together.
    public let notes: [VaultDocument]
    /// Tags across fragments, most used first; `inbox` is implicit on every fragment and left out.
    public let tags: [TagCount]

    public static let empty = VaultIndex(documents: [])

    public init(documents: [VaultDocument]) {
        fragments = documents
            .filter { $0.kind == .fragment }
            .sorted(by: Self.timelineOrder)
        notes = documents
            .filter { $0.kind == .note }
            .sorted { $0.path.utf8.lexicographicallyPrecedes($1.path.utf8) }

        var counts: [String: Int] = [:]
        for fragment in fragments {
            for tag in Set(fragment.tags) where tag != ShardTags.inbox {
                counts[tag, default: 0] += 1
            }
        }
        tags = counts
            .map { TagCount(name: $0.key, count: $0.value) }
            .sorted { $0.count != $1.count ? $0.count > $1.count : $0.name.utf8.lexicographicallyPrecedes($1.name.utf8) }
    }

    public func fragments(taggedWith tag: String) -> [VaultDocument] {
        fragments.filter { $0.tags.contains(tag) }
    }

    /// Every whitespace-separated keyword must match (like `shard -s`), ignoring case and
    /// full/half width. Fragments come first in timeline order, then notes.
    public func search(_ query: String) -> [VaultDocument] {
        let keywords = query.split(whereSeparator: \.isWhitespace).map(String.init)
        guard !keywords.isEmpty else { return [] }
        return (fragments + notes).filter { document in
            let haystack = ([document.title, document.body] + document.tags).joined(separator: "\n")
            return keywords.allSatisfy { haystack.range(of: $0, options: [.caseInsensitive, .widthInsensitive]) != nil }
        }
    }

    static func timelineOrder(_ lhs: VaultDocument, _ rhs: VaultDocument) -> Bool {
        if lhs.pinned != rhs.pinned {
            return lhs.pinned
        }
        let left = lhs.createdAt ?? "", right = rhs.createdAt ?? ""
        if left != right {
            return right.utf8.lexicographicallyPrecedes(left.utf8)
        }
        return lhs.path.utf8.lexicographicallyPrecedes(rhs.path.utf8)
    }
}
