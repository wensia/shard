import Foundation
import Yams

/// Which vault files the phone mirrors. Private and internal areas never leave the desktop.
public enum VaultPaths {
    static let documentRoots = ["fragments/", "notes/"]
    static let excludedRoots = ["lockbox/", ".shard/", ".trash/"]

    /// Markdown shown in the app: `fragments/**.md` and `notes/**.md`, no hidden components.
    public static func isSyncedDocument(_ path: String) -> Bool {
        documentRoots.contains(where: path.hasPrefix) && path.hasSuffix(".md") && !hasHiddenComponent(path)
    }

    /// Image extensions the desktop library treats as images (`shard-core::image`).
    static let imageExtensions: Set<String> = ["avif", "gif", "heic", "heif", "jpeg", "jpg", "png", "svg", "webp"]

    /// Images fetched lazily when shown: content-addressed attachments under `assets/`, and
    /// named images the desktop library keeps next to documents under `notes/`.
    public static func isAsset(_ path: String) -> Bool {
        guard !hasHiddenComponent(path) else { return false }
        if path.hasPrefix("assets/") { return true }
        guard path.hasPrefix("notes/"), let dot = path.lastIndex(of: ".") else { return false }
        return imageExtensions.contains(path[path.index(after: dot)...].lowercased())
    }

    public static func isExcluded(_ path: String) -> Bool {
        excludedRoots.contains(where: path.hasPrefix) || hasHiddenComponent(path)
    }

    private static func hasHiddenComponent(_ path: String) -> Bool {
        path.split(separator: "/").contains { $0.hasPrefix(".") }
    }
}

/// A fragment or note read from the mirrored vault.
public struct VaultDocument: Identifiable, Hashable, Sendable {
    public enum Kind: String, Sendable, Codable {
        case fragment
        case note
    }

    public var id: String { path }
    public let path: String
    public let kind: Kind
    public let fragmentID: String?
    /// Note file name without `.md`; fragments have no title of their own.
    public let title: String
    /// Markdown as the desktop shows it (frontmatter removed, leading newlines trimmed).
    public let body: String
    public let tags: [String]
    /// RFC 3339 strings exactly as stored; the desktop sorts by comparing these strings.
    public let createdAt: String?
    public let updatedAt: String?
    public let pinned: Bool
    public let source: String?
    /// Captured on this phone and not yet committed to the remote.
    public let isPending: Bool

    public var typeTag: String? { ShardTags.deriveType(tags) }

    public init(
        path: String,
        kind: Kind,
        fragmentID: String?,
        title: String,
        body: String,
        tags: [String],
        createdAt: String?,
        updatedAt: String?,
        pinned: Bool,
        source: String?,
        isPending: Bool = false
    ) {
        self.path = path
        self.kind = kind
        self.fragmentID = fragmentID
        self.title = title
        self.body = body
        self.tags = tags
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.pinned = pinned
        self.source = source
        self.isPending = isPending
    }

    public static func parse(path: String, text: String, isPending: Bool = false) -> VaultDocument {
        let kind: Kind = path.hasPrefix("fragments/") ? .fragment : .note
        let fileName = (path as NSString).lastPathComponent
        let title = fileName.hasSuffix(".md") ? String(fileName.dropLast(3)) : fileName

        guard let split = Frontmatter.split(text), let fields = Frontmatter.fields(split.yaml) else {
            // No (or unreadable) frontmatter: notes are plain Markdown; tags come from the text.
            return VaultDocument(
                path: path, kind: kind, fragmentID: nil, title: title, body: text,
                tags: ShardTags.extractTags(text), createdAt: nil, updatedAt: nil, pinned: false, source: nil,
                isPending: isPending
            )
        }
        let body = String(split.body.drop(while: { $0 == "\n" }))
        let tags = fields.strings("tags") ?? ShardTags.extractTags(body)
        return VaultDocument(
            path: path,
            kind: kind,
            fragmentID: fields.string("id"),
            title: title,
            body: body,
            tags: tags,
            createdAt: fields.string("created_at"),
            updatedAt: fields.string("updated_at"),
            pinned: fields.bool("pinned") ?? false,
            source: fields.string("source"),
            isPending: isPending
        )
    }
}

/// Splits and reads frontmatter like `shard_core::frontmatter::parse_fragment`.
enum Frontmatter {
    /// `---\n<yaml>\n---<body>`; the body keeps whatever follows the closing marker.
    static func split(_ text: String) -> (yaml: String, body: String)? {
        guard text.hasPrefix("---\n") else { return nil }
        let rest = text.dropFirst(4)
        guard let boundary = rest.range(of: "\n---") else { return nil }
        return (String(rest[..<boundary.lowerBound]), String(rest[boundary.upperBound...]))
    }

    /// Reads scalars as written: composing (not constructing) keeps timestamps as strings.
    static func fields(_ yaml: String) -> Fields? {
        guard let node = try? Yams.compose(yaml: yaml), let mapping = node.mapping else { return nil }
        return Fields(mapping: mapping)
    }

    struct Fields {
        let mapping: Node.Mapping

        func string(_ key: String) -> String? {
            guard let scalar = mapping[key]?.scalar else { return nil }
            // A plain `null` is YAML null (e.g. `category: null`); a quoted 'null' is text.
            if scalar.style == .plain, ["", "~", "null", "Null", "NULL"].contains(scalar.string) {
                return nil
            }
            return scalar.string
        }

        func strings(_ key: String) -> [String]? {
            guard let value = mapping[key] else { return nil }
            if let sequence = value.sequence {
                return sequence.compactMap { $0.scalar?.string }
            }
            return value.scalar.map { [$0.string] }
        }

        func bool(_ key: String) -> Bool? {
            guard let scalar = mapping[key]?.scalar else { return nil }
            switch scalar.string {
            case "true", "True", "TRUE": return true
            case "false", "False", "FALSE": return false
            default: return nil
            }
        }
    }
}
