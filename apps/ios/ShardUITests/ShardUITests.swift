import XCTest

/// Drives the app against `scripts/mock-github.py` (port 18787) serving a vault clone,
/// and attaches a screenshot at each step for review.
final class ShardUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testBrowseVault() throws {
        let app = launchConnected()

        let firstCard = app.buttons.matching(identifier: "document-card").firstMatch
        XCTAssertTrue(firstCard.waitForExistence(timeout: 60), "timeline never filled")
        snapshot("01-timeline")

        firstCard.tap()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 10))
        sleep(2)
        snapshot("02-fragment-detail")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // TabView keeps every tab's views in the hierarchy, so rows are found by identifier.
        app.tabBars.buttons["标签"].tap()
        let tagRow = app.buttons.matching(identifier: "tag-row").firstMatch
        XCTAssertTrue(tagRow.waitForExistence(timeout: 10))
        snapshot("03-tags")
        tagRow.tap()
        XCTAssertTrue(app.buttons.matching(identifier: "document-card").firstMatch.waitForExistence(timeout: 10))
        snapshot("04-tag-timeline")

        app.tabBars.buttons["笔记"].tap()
        let noteRow = app.buttons.matching(identifier: "note-row").element(boundBy: 4)
        XCTAssertTrue(noteRow.waitForExistence(timeout: 10))
        snapshot("05-notes")
        noteRow.tap()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 10))
        sleep(2)
        snapshot("06-note-detail")
    }

    @MainActor
    func testSearchRequiresAllKeywords() throws {
        let app = launchConnected()
        XCTAssertTrue(app.buttons.matching(identifier: "document-card").firstMatch.waitForExistence(timeout: 60))
        app.swipeDown()
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("zzz-no-such-keyword")
        XCTAssertTrue(app.staticTexts["没有找到"].waitForExistence(timeout: 5))
        snapshot("07-search-empty")
    }

    @MainActor
    private func launchConnected() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += [
            "-debugReset", "YES",
            "-debugRepository", "wensia/shard-vault@main",
            "-debugToken", "ui-test",
            "-githubAPIBase", "http://127.0.0.1:18787",
        ]
        app.launch()
        return app
    }

    @MainActor
    private func snapshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
