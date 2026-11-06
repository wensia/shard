import Foundation
import Testing
@testable import ShardKit

/// Replays `Fixtures/format-fixtures.json`, generated from the Rust implementation by
/// `crates/shard-core/tests/ios_fixtures.rs`. A failure here means iOS would write
/// fragments the desktop does not produce byte for byte.
private struct FormatFixtures: Decodable {
    struct Extract: Decodable {
        let input: String
        let expected: [String]
    }

    struct Normalize: Decodable {
        let input: [String]
        let includeInbox: Bool
        let expected: [String]
    }

    struct TypeCase: Decodable {
        let input: [String]
        let expected: [String]
    }

    struct Capture: Decodable {
        let content: String
        let id: String
        let createdAt: String
        let epochMicros: Int64
        let offsetSeconds: Int
        let expectedTags: [String]
        let expectedPath: String
        let expectedText: String
    }

    struct Timestamp: Decodable {
        let epochMicros: Int64
        let offsetSeconds: Int
        let expected: String
    }

    struct Scalar: Decodable {
        let input: String
        let expected: String
    }

    let extractTags: [Extract]
    let normalizeTags: [Normalize]
    let normalizeTypeTags: [TypeCase]
    let captures: [Capture]
    let rfc3339: [Timestamp]
    let yamlScalars: [Scalar]

    static func load() throws -> FormatFixtures {
        let url = try #require(Bundle.module.url(forResource: "format-fixtures", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode(FormatFixtures.self, from: Data(contentsOf: url))
    }
}

private func date(epochMicros: Int64) -> Date {
    Date(timeIntervalSince1970: Double(epochMicros) / 1_000_000)
}

/// Compares by bytes, as Rust does; Swift `==` would treat NFC/NFD forms as equal.
private func bytes(_ values: [String]) -> [[UInt8]] {
    values.map { Array($0.utf8) }
}

@Suite struct FormatFixtureTests {
    @Test func extractTagsMatchesRust() throws {
        for item in try FormatFixtures.load().extractTags {
            #expect(bytes(ShardTags.extractTags(item.input)) == bytes(item.expected), "input: \(item.input.debugDescription)")
        }
    }

    @Test func normalizeTagsMatchesRust() throws {
        for item in try FormatFixtures.load().normalizeTags {
            let result = ShardTags.normalizeTags(item.input, includeInbox: item.includeInbox)
            #expect(bytes(result) == bytes(item.expected), "input: \(item.input)")
        }
    }

    @Test func normalizeTypeTagsMatchesRust() throws {
        for item in try FormatFixtures.load().normalizeTypeTags {
            #expect(ShardTags.normalizeTypeTags(item.input) == item.expected, "input: \(item.input)")
        }
    }

    @Test func rfc3339MatchesChrono() throws {
        for item in try FormatFixtures.load().rfc3339 {
            let zone = try #require(TimeZone(secondsFromGMT: item.offsetSeconds))
            #expect(RFC3339.format(date(epochMicros: item.epochMicros), timeZone: zone) == item.expected)
        }
    }

    @Test func yamlScalarsMatchSerdeYAML() throws {
        for item in try FormatFixtures.load().yamlScalars {
            #expect(Array(YAMLScalar.emit(item.input).utf8) == Array(item.expected.utf8), "input: \(item.input.debugDescription)")
        }
    }

    @Test func capturedFragmentsMatchDesktopFiles() throws {
        for item in try FormatFixtures.load().captures {
            let zone = try #require(TimeZone(secondsFromGMT: item.offsetSeconds))
            #expect(bytes(ShardTags.captureTags(for: item.content)) == bytes(item.expectedTags))

            let fragment = try NewFragment.make(
                content: item.content,
                now: date(epochMicros: item.epochMicros),
                timeZone: zone,
                id: item.id
            )
            #expect(fragment.createdAt == item.createdAt)
            #expect(fragment.path == item.expectedPath)
            #expect(Array(fragment.text.utf8) == Array(item.expectedText.utf8), "case \(item.id)")
        }
    }
}

@Suite struct NewFragmentTests {
    @Test func rejectsBlankContent() {
        #expect(throws: NewFragment.Failure.emptyContent) {
            try NewFragment.make(content: " \n\u{3000}\t")
        }
    }

    @Test func rejectsLockboxFragments() {
        #expect(throws: NewFragment.Failure.lockboxNotSupported) {
            try NewFragment.make(content: "银行卡密码 #密匣")
        }
    }

    @Test func generatedIDsFollowDesktopShape() throws {
        let zone = try #require(TimeZone(secondsFromGMT: 8 * 3600))
        let id = FragmentID.make(now: date(epochMicros: 1_791_886_953_683_399), timeZone: zone)
        #expect(id.wholeMatch(of: /20261013-182233-[0-9a-f]{8}-[0-9a-f]{6}/) != nil, "\(id)")
    }

    @Test func fractionThatRoundsUpCarriesIntoSeconds() throws {
        let zone = try #require(TimeZone(secondsFromGMT: 0))
        let instant = Date(timeIntervalSince1970: 1_767_196_799.999_999_7)
        #expect(RFC3339.format(instant, timeZone: zone) == "2025-12-31T16:00:00+00:00")
    }
}
