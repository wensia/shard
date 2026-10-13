import Foundation

/// A fragment captured on iOS, ready to be written to `fragments/YYYY/MM/{id}.md`.
///
/// Mirrors `create_public_fragment_with_id_in_vault` + `write_fragment_file` in
/// shard-core: same id shape, directory, frontmatter field order and YAML style.
public struct NewFragment: Equatable, Sendable {
    public var id: String
    /// Vault-relative path, e.g. `fragments/2026/10/20261013-182233-1a2b3c4d-5e6f70.md`.
    public var path: String
    public var createdAt: String
    public var tags: [String]
    public var body: String
    /// Complete file text including frontmatter.
    public var text: String

    public enum Failure: Error, Equatable {
        case emptyContent
        /// The lockbox needs desktop-side encryption; iOS does not create lockbox fragments.
        case lockboxNotSupported
    }

    public static let source = "ios"

    public static func make(
        content: String,
        now: Date = Date(),
        timeZone: TimeZone = .current,
        id: String? = nil
    ) throws(Failure) -> NewFragment {
        let body = trimWhitespace(content)
        if body.isEmpty {
            throw .emptyContent
        }
        let tags = ShardTags.captureTags(for: content)
        if ShardTags.containsLockbox(tags) {
            throw .lockboxNotSupported
        }
        // One microsecond-rounded instant drives the id, directory and created_at alike.
        let now = Date(timeIntervalSince1970: (now.timeIntervalSince1970 * 1_000_000).rounded() / 1_000_000)
        let id = id ?? FragmentID.make(now: now, timeZone: timeZone)
        let createdAt = RFC3339.format(now, timeZone: timeZone)
        return build(id: id, createdAt: createdAt, tags: tags, source: source, body: body, now: now, timeZone: timeZone)
    }

    /// Assembles the file from already normalized parts (also used by the fixture tests).
    static func build(
        id: String,
        createdAt: String,
        tags: [String],
        source: String,
        body: String,
        now: Date,
        timeZone: TimeZone
    ) -> NewFragment {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month], from: now)
        let directory = String(format: "fragments/%04d/%02d", parts.year ?? 0, parts.month ?? 0)

        var yaml = "id: \(YAMLScalar.emit(id))\n"
        yaml += "created_at: \(YAMLScalar.emit(createdAt))\n"
        yaml += "updated_at: \(YAMLScalar.emit(createdAt))\n"
        yaml += tags.isEmpty ? "tags: []\n" : "tags:\n" + tags.map { "- \(YAMLScalar.emit($0))\n" }.joined()
        yaml += "category: null\n"
        yaml += "ai_status: none\n"
        yaml += "source: \(YAMLScalar.emit(source))\n"

        let text = "---\n\(yaml)---\n\n\(trimTrailingWhitespace(body))\n"
        return NewFragment(id: id, path: "\(directory)/\(id).md", createdAt: createdAt, tags: tags, body: body, text: text)
    }

    /// Rust `str::trim` (Unicode White_Space at both ends).
    static func trimWhitespace(_ value: String) -> String {
        trimTrailingWhitespace(String(String.UnicodeScalarView(value.unicodeScalars.drop(while: ShardTags.isWhitespace))))
    }

    static func trimTrailingWhitespace(_ value: String) -> String {
        var scalars = Array(value.unicodeScalars)
        while let last = scalars.last, ShardTags.isWhitespace(last) {
            scalars.removeLast()
        }
        return ShardTags.string(scalars)
    }
}

/// `new_fragment_id`: `YYYYMMDD-HHMMSS-<8 hex>-<6 hex>` from 7 random bytes.
public enum FragmentID {
    public static func make(now: Date, timeZone: TimeZone) -> String {
        var generator = SystemRandomNumberGenerator()
        let bytes = (0..<7).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
        let hex = bytes.map { String(format: "%02x", $0) }
        return "\(timestamp(now, timeZone: timeZone))-\(hex[..<4].joined())-\(hex[4...].joined())"
    }

    static func timestamp(_ date: Date, timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        return String(
            format: "%04d%02d%02d-%02d%02d%02d",
            c.year ?? 0, c.month ?? 0, c.day ?? 0, c.hour ?? 0, c.minute ?? 0, c.second ?? 0
        )
    }
}

/// chrono's `to_rfc3339()` (`SecondsFormat::AutoSi`, `+00:00` rather than `Z`).
public enum RFC3339 {
    public static func format(_ date: Date, timeZone: TimeZone) -> String {
        // Date is a Double; settle on whole microseconds (what macOS clocks report) before
        // splitting, so a fraction that rounds up carries into the seconds.
        let totalMicros = Int64((date.timeIntervalSince1970 * 1_000_000).rounded())
        let (seconds, micros) = totalMicros.quotientAndRemainder(dividingBy: 1_000_000)
        let whole = micros < 0 ? seconds - 1 : seconds
        let fractionMicros = micros < 0 ? micros + 1_000_000 : micros
        let wholeDate = Date(timeIntervalSince1970: TimeInterval(whole))

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: wholeDate)
        var fraction = ""
        if fractionMicros != 0 {
            fraction = fractionMicros % 1000 == 0
                ? String(format: ".%03lld", fractionMicros / 1000)
                : String(format: ".%06lld", fractionMicros)
        }
        let offset = timeZone.secondsFromGMT(for: wholeDate)
        let sign = offset < 0 ? "-" : "+"
        let minutes = abs(offset) / 60
        return String(
            format: "%04d-%02d-%02dT%02d:%02d:%02d%@%@%02d:%02d",
            c.year ?? 0, c.month ?? 0, c.day ?? 0, c.hour ?? 0, c.minute ?? 0, c.second ?? 0,
            fraction, sign, minutes / 60, minutes % 60
        )
    }
}
