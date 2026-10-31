import Foundation
import XCTest

/// Uses only scripts/mock-server.py on loopback. Run on a dedicated test simulator.
final class ServerLoginUITests: XCTestCase {
    private let server = "http://127.0.0.1:18789"
    private let email = "me@example.com"
    private let password = "correct horse battery"

    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testLoginRejectsWrongPasswordAndRestoresSessionAfterRelaunch() async throws {
        try await control("reset")
        let app = launch(reset: true)
        XCTAssertTrue(app.textFields["server-address"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "当前账号")).firstMatch.exists)
        snapshot("server-login-form")
        replace(app.textFields["login-email"], with: email)
        replace(passwordField(app), with: "wrong-password")
        app.buttons["password-visibility"].tap()
        XCTAssertTrue(app.textFields["login-password"].waitForExistence(timeout: 3), app.debugDescription)
        app.buttons["password-visibility"].tap()
        XCTAssertTrue(app.secureTextFields["login-password"].waitForExistence(timeout: 3), app.debugDescription)
        app.buttons["login-submit"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "邮箱或密码")).firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["login-submit"].exists)
        XCTAssertFalse(app.buttons.matching(identifier: "document-card").firstMatch.exists)
        let rejectedState = try await fixtureState()
        XCTAssertEqual(rejectedState.loginCount, 0)
        snapshot("server-login-wrong-password")

        replace(passwordField(app), with: password)
        app.buttons["login-submit"].tap()
        try await expectTimeline(app)
        let connectedState = try await fixtureState()
        XCTAssertEqual(connectedState.loginCount, 1)
        snapshot("server-login-timeline")
        app.tabBars.buttons["笔记"].tap()
        XCTAssertTrue(app.buttons.matching(identifier: "note-row").firstMatch.waitForExistence(timeout: 10))
        snapshot("server-login-notes")

        app.terminate()
        app.launchArguments = []
        app.launch()
        try await expectTimeline(app)
        let restoredState = try await fixtureState()
        XCTAssertEqual(restoredState.loginCount, 1, "relaunch must reuse the device token")
        snapshot("server-login-restored-session")
    }

    @MainActor
    func testOfflineCaptureSurvivesRelaunchAndSyncsOnce() async throws {
        try await control("reset")
        let app = launch(reset: true)
        try await login(app)
        try await control("offline", body: ["enabled": true])
        let marker = "IOSOFFLINE\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
        app.buttons["compose-button"].tap()
        let editor = app.textViews["compose-editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5), "Composer did not open:\n\(app.debugDescription)\n\(XCUIApplication(bundleIdentifier: "com.apple.springboard").debugDescription)")
        editor.tap()
        editor.typeText("离线碎片 \(marker) #登录测试")
        app.buttons["compose-send"].tap()
        let card = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", marker)).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 10), app.debugDescription)
        let offlineState = try await fixtureState(marker: marker)
        XCTAssertEqual(offlineState.matchingFragmentCount, 0)
        snapshot("server-login-offline-capture")

        app.terminate()
        try await control("offline", body: ["enabled": false])
        app.launchArguments = []
        app.launch()
        XCTAssertTrue(card.waitForExistence(timeout: 15), app.debugDescription)
        let synced = try await eventually {
            let state = try await self.fixtureState(marker: marker)
            return state.matchingFragmentCount == 1 && state.createdCount == 1
        }
        XCTAssertTrue(synced)
        app.terminate()
        app.launch()
        XCTAssertTrue(card.waitForExistence(timeout: 15), app.debugDescription)
        let state = try await fixtureState(marker: marker)
        XCTAssertEqual(state.matchingFragmentCount, 1)
        XCTAssertEqual(state.createdCount, 1)
        snapshot("server-login-offline-synced-once")
    }

    @MainActor
    func testRevokedTokenRequiresLoginAndLogoutReturnsToLogin() async throws {
        try await control("reset")
        let app = launch(reset: true)
        try await login(app)
        try await control("revoke")
        app.terminate()
        app.launchArguments = []
        app.launch()
        XCTAssertTrue(app.buttons["login-submit"].waitForExistence(timeout: 15), app.debugDescription)
        snapshot("server-login-revoked")
        try await login(app)
        let reauthenticatedState = try await fixtureState()
        XCTAssertEqual(reauthenticatedState.loginCount, 2)
        app.buttons["设置"].tap()
        let logout = app.buttons["logout-submit"]
        XCTAssertTrue(logout.waitForExistence(timeout: 5))
        logout.tap()
        XCTAssertTrue(app.buttons["login-submit"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "当前账号")).firstMatch.exists)
        snapshot("server-login-signed-out")
        app.terminate()
        app.launchArguments = []
        app.launch()
        XCTAssertTrue(app.buttons["login-submit"].waitForExistence(timeout: 10))
    }

    @MainActor
    private func launch(reset: Bool) -> XCUIApplication {
        addUIInterruptionMonitor(withDescription: "Decline saving fixture credentials") { interruption in
            let titles = ["保存密码？", "保存密码?", "Save Password?", "Save Password"]
            let isPasswordPrompt = titles.contains(interruption.label)
                || interruption.staticTexts.matching(NSPredicate(format: "label IN %@", titles)).firstMatch.exists
            guard isPasswordPrompt else { return false }
            let decline = interruption.buttons.matching(NSPredicate(
                format: "label IN %@", ["以后", "Not Now", "稍后", "Later"]
            )).firstMatch
            guard decline.waitForExistence(timeout: 3) else { return false }
            decline.tap()
            return true
        }
        let app = XCUIApplication()
        app.launchArguments = ["-debugServer", server]
        if reset { app.launchArguments += ["-debugReset", "YES"] }
        app.launch()
        return app
    }

    @MainActor
    private func login(_ app: XCUIApplication) async throws {
        XCTAssertTrue(app.buttons["login-submit"].waitForExistence(timeout: 10))
        replace(app.textFields["login-email"], with: email)
        replace(passwordField(app), with: password)
        app.buttons["login-submit"].tap()
        try await expectTimeline(app)
    }

    @MainActor
    private func expectTimeline(_ app: XCUIApplication) async throws {
        XCTAssertTrue(app.buttons.matching(identifier: "document-card").firstMatch.waitForExistence(timeout: 30), app.debugDescription)
        // Login may finish behind iOS's legitimate password-manager prompt. Decline
        // saving the dummy test password before the next app action; never save it.
        await dismissPasswordSavePrompt(app)
        XCTAssertFalse(app.buttons["login-submit"].exists, app.debugDescription)
    }

    @MainActor
    private func dismissPasswordSavePrompt(_ app: XCUIApplication) async {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let roots = [app, springboard]
        let titles = ["保存密码？", "保存密码?", "Save Password?", "Save Password"]
        let titlePredicate = NSPredicate(format: "label IN %@", titles)
        let declinePredicate = NSPredicate(format: "label IN %@", ["以后", "Not Now", "稍后", "Later"])
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(4))
        // Depending on the iOS version, password-manager UI is exposed through a
        // remote layer of the tested app or directly through SpringBoard.
        while clock.now < deadline {
            if let host = roots.first(where: { $0.staticTexts.matching(titlePredicate).firstMatch.exists }) {
                let alternatives = [host] + roots.filter { $0 !== host }
                for root in alternatives {
                    let decline = root.buttons.matching(declinePredicate).firstMatch
                    if decline.waitForExistence(timeout: 3) {
                        decline.tap()
                        let goneDeadline = clock.now.advanced(by: .seconds(5))
                        while clock.now < goneDeadline {
                            let titleGone = !roots.contains(where: { $0.staticTexts.matching(titlePredicate).firstMatch.exists })
                            let declineGone = !roots.contains(where: { $0.buttons.matching(declinePredicate).firstMatch.exists })
                            if titleGone && declineGone {
                                // System password UI drops its AX nodes before its
                                // remote presentation finishes dismissing. Wait for
                                // that known transition, then require a stable hit target.
                                try? await Task.sleep(for: .milliseconds(400))
                                let compose = app.buttons["compose-button"]
                                if compose.exists && compose.isHittable {
                                    try? await Task.sleep(for: .milliseconds(200))
                                    if compose.exists && compose.isHittable { return }
                                }
                            }
                            try? await Task.sleep(for: .milliseconds(100))
                        }
                        XCTFail("Password-save dismissal did not restore app interaction:\n\(app.debugDescription)\n\(springboard.debugDescription)")
                        return
                    }
                }
                XCTFail("Password-save prompt has no decline action:\n\(app.debugDescription)\n\(springboard.debugDescription)")
                return
            }
            try? await Task.sleep(for: .milliseconds(100))
        }
    }

    @MainActor
    private func passwordField(_ app: XCUIApplication) -> XCUIElement {
        let secure = app.secureTextFields["login-password"]
        return secure.exists ? secure : app.textFields["login-password"]
    }

    @MainActor
    private func replace(_ field: XCUIElement, with text: String) {
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        let value = field.value as? String ?? ""
        if value != field.placeholderValue && !value.isEmpty {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count))
        }
        field.typeText(text)
    }

    private struct FixtureState: Decodable, Sendable {
        let loginCount: Int
        let createdCount: Int
        let matchingFragmentCount: Int
    }

    @MainActor
    private func fixtureState(marker: String? = nil) async throws -> FixtureState {
        var url = URLComponents(string: server + "/__test/state")!
        if let marker { url.queryItems = [URLQueryItem(name: "marker", value: marker)] }
        let (data, response) = try await URLSession.shared.data(from: url.url!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try JSONDecoder().decode(FixtureState.self, from: data)
    }

    @MainActor
    private func control(_ action: String, body: [String: Bool] = [:]) async throws {
        var request = URLRequest(url: URL(string: server + "/__test/" + action)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }

    @MainActor
    private func eventually(_ condition: @MainActor () async throws -> Bool) async rethrows -> Bool {
        for _ in 0..<100 {
            if try await condition() { return true }
            try? await Task.sleep(for: .milliseconds(200))
        }
        return false
    }

    @MainActor
    private func snapshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
