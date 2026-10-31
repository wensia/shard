import ShardKit
import SwiftUI

/// kiln palette as asset colors (light and dark variants live in the asset catalog).
enum Theme {
    static let minimumTouchTarget: CGFloat = 44
    static let canvas = Color("Canvas")
    static let surface = Color("Surface")
    static let fill = Color("Fill")
    static let ink = Color("Ink")
    static let mutedInk = Color("MutedInk")
    static let line = Color("Line")
    static let accent = Color("AccentColor")
    /// `--shard-editor-tag-fg`: tags are tinted inline, never drawn as chips.
    static let tagInk = Color("TagInk")
}

@MainActor
enum DisplayDate {
    private static let parser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let wholeSecondParser = ISO8601DateFormatter()

    static func parse(_ value: String?) -> Date? {
        guard let value else { return nil }
        return parser.date(from: value) ?? wholeSecondParser.date(from: value)
    }

    /// `10月13日 18:22` this year, `2025年12月31日 23:59` otherwise.
    static func short(_ value: String?) -> String {
        guard let date = parse(value) else { return "" }
        let sameYear = Calendar.current.isDate(date, equalTo: Date(), toGranularity: .year)
        let style = Date.FormatStyle(date: .omitted, time: .shortened)
        let day = sameYear
            ? date.formatted(.dateTime.month(.defaultDigits).day())
            : date.formatted(.dateTime.year().month(.defaultDigits).day())
        return "\(day) \(date.formatted(style))"
    }
}

enum ContentType {
    /// Labels from src/lib/content-kind.ts; plain fragments carry no badge.
    static func label(for tag: String?) -> String? {
        switch tag {
        case "document": "文档"
        case "outline": "大纲"
        case "flowchart": "流程图"
        default: nil
        }
    }
}

enum Preview {
    private static let characterLimit = 600

    /// Fragment source with `#tags` tinted, like the desktop editor and cards.
    static func highlighted(_ body: String) -> AttributedString {
        let text = compact(body)
        var attributed = AttributedString(text)
        for range in ShardTags.tagRanges(in: text) {
            if let lower = AttributedString.Index(range.lowerBound, within: attributed),
               let upper = AttributedString.Index(range.upperBound, within: attributed) {
                attributed[lower..<upper].foregroundColor = Theme.tagInk
            }
        }
        return attributed
    }

    /// Images become a marker, task items get boxes and long bodies are cut; blank lines stay
    /// as written (Markdown dialect v2: one source line is one displayed line). The detail
    /// view renders everything.
    static func compact(_ body: String) -> String {
        var text = body.replacing(/!\[([^\]]*)\]\([^)]*\)/) { match in
            match.output.1.isEmpty ? "[图片]" : "[图片：\(match.output.1)]"
        }
        text = text.replacing(/^([ \t]*)[-*+][ \t]+\[[xX]\][ \t]+/.anchorsMatchLineEndings()) { "\($0.output.1)☑ " }
        text = text.replacing(/^([ \t]*)[-*+][ \t]+\[ \][ \t]+/.anchorsMatchLineEndings()) { "\($0.output.1)☐ " }
        if text.count > characterLimit {
            text = String(text.prefix(characterLimit)) + "…"
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// `deriveDocumentDigest`: first heading (or first line) as title, then a plain summary.
    static func documentDigest(_ body: String) -> (title: String, summary: String) {
        let lines = body.components(separatedBy: .newlines)
        let headingIndex = lines.firstIndex { $0.wholeMatch(of: /#{1,6}\s+.+/) != nil }
        let titleIndex = headingIndex ?? lines.firstIndex { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        guard let titleIndex else { return ("", "") }
        let title = plain(lines[titleIndex].replacing(/^#{1,6}\s+|\s+#+\s*$/, with: ""))
        let rest = headingIndex == nil
            ? lines[(titleIndex + 1)...]
            : ArraySlice(lines.enumerated().filter { $0.offset != titleIndex }.map(\.element))
        let summary = rest.map(plain).filter { !$0.isEmpty }.joined(separator: " ")
        return (String(title.prefix(40)), String(summary.prefix(120)))
    }

    private static func plain(_ line: String) -> String {
        line
            .replacing(/!\[[^\]]*\]\([^)]*\)/, with: "")
            .replacing(/\[([^\]]*)\]\([^)]*\)/) { String($0.output.1) }
            .replacing(/^\s*(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s*|#{1,6}\s+)/, with: "")
            .replacing(/[*_`~]+/, with: "")
            .trimmingCharacters(in: .whitespaces)
    }
}
