import Foundation
import XCTest

/// Uses only web-server-fixture.py and a dedicated simulator, never production.
/// The fixture forwards to a real Rust server backed by a TemporaryDirectory.
final class WebWorkspaceUITests: XCTestCase {
    private let server = "http://localhost:18792"
    private let controlServer = "http://127.0.0.1:18792"
    private let email = "me@example.com"
    private let password = "correct horse battery"
    // The blank line after the list matters: cards share the editor's CommonMark parser, where a line
    // directly under a list item is a lazy continuation of that task, not a paragraph of its own.
    private let renderingBody = #"""
    - [ ] 项目
    - [x] 完成

    甲\
    乙

    字面 / 和 \路径
    """#

    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testTimelineUsesSharedHTMLTasksAndPreservesMarkdownLineBreaks() async throws {
        try await control("reset", body: ["fragmentContent": renderingBody])
        let app = launch(reset: true)
        try await login(app)
        let web = app.webViews.firstMatch

        // A native Unicode preview cannot satisfy these HTML button queries.
        XCTAssertTrue(interactive("标记为完成", in: web).waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertTrue(interactive("标记为未完成", in: web).exists, app.debugDescription)
        XCTAssertFalse(web.staticTexts["☐ 项目"].exists)
        XCTAssertFalse(web.staticTexts["☑ 完成"].exists)
        XCTAssertTrue(interactive("资料库", in: web).exists, "The workspace should use the shared Web navigation")
        XCTAssertEqual(app.tabBars.count, 0, "The server workspace must not retain a second native tab layout")

        let first = web.staticTexts["甲"]
        let second = web.staticTexts["乙"]
        let literal = web.staticTexts[#"字面 / 和 \路径"#]
        XCTAssertTrue(first.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(second.exists, app.debugDescription)
        XCTAssertTrue(literal.exists, "Literal slashes and path backslashes must survive Markdown display")
        XCTAssertFalse(web.staticTexts["甲\\"].exists, "A Markdown hard-break marker must not leak into display")
        let lineStep = second.frame.minY - first.frame.minY
        XCTAssertGreaterThan(lineStep, 0, "A hard break must display the next source line below the first")
        XCTAssertLessThan(abs(first.frame.minX - second.frame.minX), 1, "A hard break starts the next line at the same edge")
        XCTAssertGreaterThan(literal.frame.minY - second.frame.minY, lineStep * 1.6,
                             "The blank source line must remain visibly blank")
        snapshot("web-workspace-tasks-hardbreaks-literal-backslash")
    }

    /// Cards over the async threshold (32,000 characters) parse in a module Worker loaded through shard://app.
    /// A Worker failure falls back to raw Markdown, which has no task buttons and keeps the literal "# ".
    @MainActor
    func testLargeCardParsesInWorkerThroughTheAppScheme() async throws {
        let filler = (1...1200).map { "填充段落 \($0)：用于把卡片推过异步解析阈值的普通文字。" }.joined(separator: "\n\n")
        let body = "# 大文档标题\n\n- [ ] 大文档任务\n\n\(filler)"
        XCTAssertGreaterThan(body.count, 32_000)
        try await control("reset", body: ["fragmentContent": body])
        let app = launch(reset: true)
        try await login(app)
        let web = app.webViews.firstMatch

        XCTAssertTrue(interactive("标记为完成", in: web).waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertTrue(web.staticTexts["大文档标题"].exists, app.debugDescription)
        XCTAssertFalse(web.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "# 大文档标题")).firstMatch.exists,
                       "A Worker failure must not leave the raw Markdown fallback on screen")
        snapshot("web-workspace-large-card-worker")
    }

    @MainActor
    func testOfflineCaptureAndCacheSurviveRelaunchAndCommitOnlyOnce() async throws {
        try await control("reset", body: ["fragmentContent": renderingBody])
        let app = launch(reset: true)
        try await login(app)
        XCTAssertTrue(interactive("标记为完成", in: app.webViews.firstMatch).waitForExistence(timeout: 20))
        try await control("pause")

        let marker = "IOSWEBOFFLINE" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let editor = app.webViews.textViews["快速记录"]
        XCTAssertTrue(editor.waitForExistence(timeout: 10), app.debugDescription)
        editor.tap()
        editor.typeText("离线记录 \(marker)")
        let send = app.webViews.buttons["保存片段"]
        let enabled = await eventually(timeout: .seconds(5)) { send.isEnabled }
        XCTAssertTrue(enabled)
        XCTAssertTrue(send.isHittable, "The on-screen keyboard must not cover the fixed composer action")
        send.tap()

        let card = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", marker)).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 15), app.debugDescription)
        let offline = try await fixtureState(marker: marker)
        XCTAssertEqual(offline.matchingFragmentCount, 0)
        XCTAssertEqual(offline.createdCount, 0)
        snapshot("web-workspace-offline-pending")

        app.terminate()
        app.launchArguments = []
        app.launch()
        XCTAssertTrue(card.waitForExistence(timeout: 20), "Pending content must reopen from native durable storage")
        XCTAssertTrue(interactive("标记为完成", in: app.webViews.firstMatch).exists,
                      "The previous server content must remain cached offline")
        snapshot("web-workspace-offline-reopened")

        try await control("resume")
        // Stay in the foreground: SSE reconnection must also drain the queue.
        let committed = try await eventually {
            let state = try await self.fixtureState(marker: marker)
            return state.matchingFragmentCount == 1 && state.createdCount == 1
        }
        XCTAssertTrue(committed, "The durable queue must submit exactly one server transaction")
        // Go offline immediately after the acknowledgement. A later successful
        // server read must not hide a gap between outbox removal and cache save.
        try await control("pause")
        app.terminate()
        app.launch()
        XCTAssertTrue(card.waitForExistence(timeout: 20),
                      "An acknowledged local capture must already be durable in the offline cache")
        let final = try await fixtureState(marker: marker)
        XCTAssertEqual(final.matchingFragmentCount, 1)
        XCTAssertEqual(final.createdCount, 1)
        snapshot("web-workspace-synced-once-and-reopened-offline")
    }

    @MainActor
    func testWrongPasswordVisibilityAndDeviceSessionRestoration() async throws {
        try await control("reset")
        let app = launch(reset: true)
        try await fillLogin(app, password: "wrong-password")
        let web = app.webViews.firstMatch
        XCTAssertFalse(web.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "当前账号")).firstMatch.exists)
        interactive("显示密码", in: web).tap()
        XCTAssertTrue(web.textFields["密码"].waitForExistence(timeout: 3), app.debugDescription)
        XCTAssertEqual(web.textFields["密码"].value as? String, "wrong-password")
        interactive("隐藏密码", in: web).tap()
        XCTAssertTrue(web.secureTextFields["密码"].waitForExistence(timeout: 3))
        web.buttons["登录"].tap()
        XCTAssertTrue(web.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "邮箱或密码不正确")).firstMatch.waitForExistence(timeout: 10), app.debugDescription)
        let rejected = try await fixtureState()
        XCTAssertEqual(rejected.rejectedLoginCount, 1)
        XCTAssertEqual(rejected.deviceLoginCount, 0)
        snapshot("web-login-rejected-password")

        replace(web.secureTextFields["密码"], with: password)
        web.buttons["登录"].tap()
        try await expectWorkspace(app)
        let loggedIn = try await fixtureState()
        XCTAssertEqual(loggedIn.deviceLoginCount, 1)
        app.terminate()
        app.launchArguments = []
        app.launch()
        try await expectWorkspace(app)
        let restored = try await fixtureState()
        XCTAssertEqual(restored.deviceLoginCount, 1, "Relaunch must reuse the existing Keychain device token")
        XCTAssertEqual(restored.loginCount, 0, "A normal reopen must not exchange an account password")
        snapshot("web-login-restored-device-session")
    }

    @MainActor
    func testRevokedDeviceAndCookieRequireLoginAndLogoutStaysSignedOut() async throws {
        try await control("reset")
        let app = launch(reset: true)
        try await login(app)
        try await openAccountSettings(app)
        let manage = app.webViews.buttons["管理设备与会话"]
        manage.tap()
        let accountPassword = app.webViews.secureTextFields["登录密码"]
        XCTAssertTrue(accountPassword.waitForExistence(timeout: 10), app.debugDescription)
        app.webViews.buttons["取消"].tap()
        let cancelled = await eventually(timeout: .seconds(5)) { !accountPassword.exists && manage.exists && manage.isEnabled }
        XCTAssertTrue(cancelled, app.debugDescription)
        XCTAssertFalse(app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "失败")).firstMatch.exists,
                       "Cancelling explicit management must not show an error toast")
        XCTAssertFalse(app.webViews.staticTexts["已取消"].exists)
        manage.tap()
        try await confirmLoginPassword(app)
        XCTAssertTrue(app.webViews.buttons["吊销"].firstMatch.waitForExistence(timeout: 10), app.debugDescription)
        let withCookie = try await fixtureState()
        XCTAssertEqual(withCookie.loginCount, 1, "Account management must establish a real browser session")
        app.webViews.buttons["关闭"].tap()
        try await control("revoke-all")
        app.terminate()
        app.launchArguments = []
        app.launch()
        XCTAssertTrue(app.webViews.buttons["登录"].waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertFalse(app.webViews.buttons["保存片段"].exists, "401 must not reopen an authenticated offline cache")
        snapshot("web-login-revoked-device-and-cookie")

        try await login(app)
        let reauthenticated = try await fixtureState()
        XCTAssertEqual(reauthenticated.deviceLoginCount, 2)
        try await openAccountSettings(app)
        let logout = app.webViews.buttons["退出登录"]
        XCTAssertTrue(logout.waitForExistence(timeout: 10), app.debugDescription)
        logout.tap()
        XCTAssertTrue(app.webViews.buttons["登录"].waitForExistence(timeout: 15), app.debugDescription)
        app.terminate()
        app.launchArguments = []
        app.launch()
        XCTAssertTrue(app.webViews.buttons["登录"].waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertFalse(app.webViews.buttons["保存片段"].exists)
        snapshot("web-login-signed-out-after-relaunch")
    }

    @MainActor
    func testLibraryEditingAndLockboxSetupPersistWithRealPasswordConfirmation() async throws {
        try await control("reset")
        let app = launch(reset: true)
        try await login(app)
        let web = app.webViews.firstMatch
        openLibraryTree(app)
        let create = named("新建", in: web)
        XCTAssertTrue(create.waitForExistence(timeout: 15), app.debugDescription)
        create.tap()
        named("新建文档", in: web).tap()
        let editor = web.textViews["资料库文档编辑器"]
        XCTAssertTrue(editor.waitForExistence(timeout: 15), app.debugDescription)
        editor.tap()
        let marker = "IOSWEBLIBRARY" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        editor.typeText("资料库正文 \(marker)")
        let saved = try await eventually(timeout: .seconds(10)) {
            try await self.fixtureState(marker: marker).matchingNoteCount == 1
        }
        XCTAssertTrue(saved, "The shared editor must persist an actual note through Rust RPC")
        snapshot("web-library-edited-with-keyboard")
        let back = web.buttons["返回所在目录"]
        XCTAssertTrue(back.waitForExistence(timeout: 5), app.debugDescription)
        back.tap()
        web.buttons["返回资料库目录"].tap()
        let lockbox = web.buttons["密匣（上锁空间）"]
        XCTAssertTrue(lockbox.waitForExistence(timeout: 10), app.debugDescription)
        lockbox.tap()
        try await confirmLoginPassword(app)
        let vaultPassword = "fixture vault password"
        let newPassword = web.secureTextFields["新密码，至少 8 个字符"]
        XCTAssertTrue(newPassword.waitForExistence(timeout: 10), app.debugDescription)
        replace(newPassword, with: vaultPassword)
        replace(web.secureTextFields["再次输入新密码"], with: vaultPassword)
        web.buttons["设置密匣"].tap()
        let confirmation = web.textFields["确认恢复密钥"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 20), app.debugDescription)
        let finalSegment = try XCTUnwrap(confirmation.placeholderValue)
        XCTAssertFalse(finalSegment.isEmpty)
        replace(confirmation, with: finalSegment)
        let savedKey = web.buttons["我已保存恢复密钥"]
        let acceptedKey = await eventually(timeout: .seconds(5)) { savedKey.isEnabled }
        XCTAssertTrue(acceptedKey)
        savedKey.tap()
        XCTAssertTrue(lockbox.waitForExistence(timeout: 5), app.debugDescription)
        lockbox.tap()
        let configuredPassword = web.secureTextFields["密匣密码"]
        XCTAssertTrue(configuredPassword.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(web.buttons["设置密匣"].exists)
        replace(configuredPassword, with: vaultPassword)
        web.buttons["解锁"].tap()
        XCTAssertTrue(web.buttons["上锁"].waitForExistence(timeout: 10), app.debugDescription)
        let verified = try await fixtureState()
        XCTAssertEqual(verified.loginCount, 1, "The local vault password must not be mistaken for the account password")
        web.buttons["上锁"].tap()
        // handleLockLockbox deliberately returns to the public library.
        openLibraryTree(app)
        web.buttons["密匣（上锁空间）"].tap()
        replace(web.secureTextFields["密匣密码"], with: vaultPassword)
        web.buttons["解锁"].tap()
        XCTAssertTrue(web.buttons["上锁"].waitForExistence(timeout: 15), app.debugDescription)
        app.terminate()
        app.launchArguments = []
        app.launch()
        // App intentionally cold-starts at the public composer, never a vault.
        try await expectWorkspace(app)
        openLibraryTree(app)
        app.webViews.buttons["密匣（上锁空间）"].tap()
        XCTAssertTrue(app.webViews.secureTextFields["密匣密码"].waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertFalse(app.webViews.buttons["设置密匣"].exists, "Saved setup must not return to first-time setup")
        replace(app.webViews.secureTextFields["密匣密码"], with: vaultPassword)
        app.webViews.buttons["解锁"].tap()
        XCTAssertTrue(app.webViews.buttons["上锁"].waitForExistence(timeout: 15), app.debugDescription)
        snapshot("web-lockbox-setup-persisted-and-unlocked")
    }

    @MainActor
    private func launch(reset: Bool) -> XCUIApplication {
        addUIInterruptionMonitor(withDescription: "Decline saving isolated fixture credentials") { interruption in
            let titles = ["保存密码？", "保存密码?", "Save Password?", "Save Password"]
            guard titles.contains(interruption.label)
                    || interruption.staticTexts.matching(NSPredicate(format: "label IN %@", titles)).firstMatch.exists
            else { return false }
            let decline = interruption.buttons.matching(NSPredicate(format: "label IN %@", ["以后", "Not Now", "稍后", "Later"])).firstMatch
            guard decline.exists else { return false }
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
        try await fillLogin(app, password: password)
        app.webViews.buttons["登录"].tap()
        try await expectWorkspace(app)
    }

    @MainActor
    private func fillLogin(_ app: XCUIApplication, password suppliedPassword: String) async throws {
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 30), app.debugDescription)
        let serverField = web.textFields["服务器地址"]
        XCTAssertTrue(serverField.waitForExistence(timeout: 15), app.debugDescription)
        let configured = URLComponents(string: serverField.value as? String ?? "")
        XCTAssertEqual(configured?.host, "localhost", "Fixture credentials must never go to production")
        XCTAssertEqual(configured?.port, 18792)
        replace(serverField, with: server)
        replace(web.textFields["邮箱"], with: email)
        replace(web.secureTextFields["密码"], with: suppliedPassword)
        XCTAssertTrue(web.buttons["登录"].exists, app.debugDescription)
    }

    @MainActor
    private func expectWorkspace(_ app: XCUIApplication) async throws {
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.buttons["保存片段"].waitForExistence(timeout: 30),
                      "WKWebView existence alone does not prove the shared React app mounted:\n\(app.debugDescription)")
        await dismissFixturePasswordPrompt(app)
    }

    @MainActor
    private func openAccountSettings(_ app: XCUIApplication) async throws {
        let web = app.webViews.firstMatch
        named("更多操作", in: web).tap()
        let settings = named("设置", in: web)
        XCTAssertTrue(settings.waitForExistence(timeout: 5), app.debugDescription)
        settings.tap()
        let manage = web.buttons["管理设备与会话"]
        XCTAssertTrue(manage.waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertFalse(web.secureTextFields["登录密码"].exists,
                       "Opening settings must not automatically ask for an account password")
        XCTAssertTrue(web.buttons["退出登录"].exists, app.debugDescription)
    }

    @MainActor
    private func openLibraryTree(_ app: XCUIApplication) {
        let web = app.webViews.firstMatch
        interactive("资料库", in: web).tap()
        let back = web.buttons["返回资料库目录"]
        XCTAssertTrue(back.waitForExistence(timeout: 10), app.debugDescription)
        back.tap()
        XCTAssertTrue(web.buttons["密匣（上锁空间）"].waitForExistence(timeout: 5), app.debugDescription)
    }

    /// Needs scripts/voice-service-fixture.py on 127.0.0.1:18794 and a granted microphone
    /// (`xcrun simctl privacy <device> grant microphone dev.shard.mobile`).
    @MainActor
    func testNativeVoiceReadAloudAndDictationStayInTheHost() async throws {
        try await control("reset")
        try await voiceFixture("reset")
        let app = launch(reset: true)
        try await login(app)
        let web = app.webViews.firstMatch

        named("更多操作", in: web).tap()
        let settings = named("设置", in: web)
        XCTAssertTrue(settings.waitForExistence(timeout: 5), app.debugDescription)
        settings.tap()
        let section = interactive("语音", in: web)
        XCTAssertTrue(section.waitForExistence(timeout: 10), app.debugDescription)
        section.tap()
        let base = web.textFields["Base URL"]
        XCTAssertTrue(base.waitForExistence(timeout: 10), app.debugDescription)
        overwrite(base, with: "http://127.0.0.1:18794/v1")
        XCTAssertEqual(base.value as? String, "http://127.0.0.1:18794/v1")
        let key = web.secureTextFields["API Key"]
        replace(key, with: "test-voice-key")
        let save = web.buttons.matching(NSPredicate(format: "label == %@", "保存")).allElementsBoundByIndex
            .filter { $0.frame.minY > key.frame.maxY }.min { $0.frame.minY < $1.frame.minY }
        XCTAssertNotNil(save, app.debugDescription)
        save?.tap()
        XCTAssertTrue(web.staticTexts["已保存"].waitForExistence(timeout: 10), app.debugDescription)
        snapshot("voice-settings-saved-native")
        web.buttons["关闭"].firstMatch.tap()

        let editor = app.webViews.textViews["快速记录"]
        XCTAssertTrue(editor.waitForExistence(timeout: 10), app.debugDescription)
        editor.tap()
        editor.typeText("原生朗读验收")
        interactive("朗读", in: web).tap()
        let spoke = try await eventually(timeout: .seconds(20)) {
            let state = try await self.voiceState()
            return state.tts == 1 && state.lastText == "原生朗读验收"
        }
        XCTAssertTrue(spoke, "Synthesis must go through the native host with the Keychain key")
        // Playback starts after the asynchronous synthesis: autoplay must not need a second tap.
        XCTAssertTrue(web.staticTexts["正在朗读"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(web.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "无法播放")).firstMatch.exists)
        snapshot("voice-read-aloud-playing")
        web.buttons["停止"].firstMatch.tap()

        interactive("语音输入", in: web).tap()
        let finish = interactive("结束并识别", in: web)
        XCTAssertTrue(finish.waitForExistence(timeout: 10), app.debugDescription)
        snapshot("voice-dictation-recording")
        try await Task.sleep(for: .milliseconds(1500))
        finish.tap()
        let inserted = await eventually(timeout: .seconds(20)) {
            (editor.value as? String)?.contains("原生识别文字") == true
                || web.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "原生识别文字")).firstMatch.exists
        }
        XCTAssertTrue(inserted, app.debugDescription)
        let state = try await voiceState()
        XCTAssertEqual(state.asr, 1)
        XCTAssertEqual(state.unauthorized, 0)
        XCTAssertEqual(state.rejected, 0)
        XCTAssertEqual(state.lastRate, 16_000)
        XCTAssertEqual(state.lastChannels, 1)
        XCTAssertEqual(state.lastBits, 16)
        XCTAssertGreaterThanOrEqual(state.lastSeconds ?? 0, 1)
        snapshot("voice-dictation-inserted")
    }

    /// Puts the caret at the end of a prefilled field and deletes the old value key by key.
    @MainActor
    private func overwrite(_ field: XCUIElement, with value: String) {
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        let previous = field.value as? String ?? ""
        // The first tap scrolls the field into view (WebKit puts the caret at the start);
        // the second lands on the now-visible trailing edge.
        field.tap()
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: previous.count + 2))
        field.typeText(value)
    }

    private struct VoiceFixtureState: Decodable {
        let asr: Int
        let tts: Int
        let unauthorized: Int
        let rejected: Int
        let lastText: String?
        let lastRate: Int?
        let lastChannels: Int?
        let lastBits: Int?
        let lastSeconds: Double?
    }

    @MainActor
    private func voiceState() async throws -> VoiceFixtureState {
        let (data, _) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:18794/__voice/state")!)
        return try JSONDecoder().decode(VoiceFixtureState.self, from: data)
    }

    @MainActor
    private func voiceFixture(_ action: String) async throws {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:18794/__voice/" + action)!)
        request.httpMethod = "POST"
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }

    @MainActor
    private func confirmLoginPassword(_ app: XCUIApplication) async throws {
        let field = app.webViews.secureTextFields["登录密码"]
        XCTAssertTrue(field.waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertFalse(app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "当前账号")).firstMatch.exists)
        replace(field, with: password)
        app.webViews.buttons["确认"].tap()
        let confirmed = await eventually(timeout: .seconds(15)) { !field.exists }
        XCTAssertTrue(confirmed, app.debugDescription)
        await dismissFixturePasswordPrompt(app)
    }

    @MainActor
    private func dismissFixturePasswordPrompt(_ app: XCUIApplication) async {
        let roots = [app, XCUIApplication(bundleIdentifier: "com.apple.springboard")]
        let titles = NSPredicate(format: "label IN %@", ["保存密码？", "保存密码?", "Save Password?", "Save Password"])
        let decline = NSPredicate(format: "label IN %@", ["以后", "Not Now", "稍后", "Later"])
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            if roots.contains(where: { $0.staticTexts.matching(titles).firstMatch.exists }) {
                if let button = roots.map({ $0.buttons.matching(decline).firstMatch }).first(where: { $0.exists }) {
                    button.tap()
                    let dismissed = await eventually(timeout: .seconds(5)) { !button.exists }
                    XCTAssertTrue(dismissed)
                    return
                }
            }
            try? await Task.sleep(for: .milliseconds(100))
        }
    }

    @MainActor
    private func replace(_ field: XCUIElement, with value: String) {
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        let previous = field.value as? String ?? ""
        if previous == value && previous != field.placeholderValue { return }
        field.tap()
        if previous != field.placeholderValue && !previous.isEmpty {
            // WebKit can place the insertion point at the start of an existing
            // URL. Use the system selection action rather than assuming the end.
            field.press(forDuration: 1.2)
            let app = XCUIApplication()
            let selectAll = app.descendants(matching: .any).matching(NSPredicate(
                format: "label IN %@ AND elementType IN %@", ["全选", "Select All"],
                [XCUIElement.ElementType.button.rawValue, XCUIElement.ElementType.menuItem.rawValue]
            )).firstMatch
            XCTAssertTrue(selectAll.waitForExistence(timeout: 3), app.debugDescription)
            selectAll.tap()
        }
        field.typeText(value)
    }

    private struct FixtureState: Decodable {
        let loginCount: Int
        let rejectedLoginCount: Int
        let deviceLoginCount: Int
        let createdCount: Int
        let matchingFragmentCount: Int
        let matchingNoteCount: Int
    }

    @MainActor
    private func fixtureState(marker: String = "") async throws -> FixtureState {
        var url = URLComponents(string: controlServer + "/__test/state")!
        url.queryItems = [URLQueryItem(name: "marker", value: marker)]
        let (data, response) = try await URLSession.shared.data(from: url.url!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try JSONDecoder().decode(FixtureState.self, from: data)
    }

    @MainActor
    private func control(_ action: String, body: [String: String] = [:]) async throws {
        var request = URLRequest(url: URL(string: controlServer + "/__test/" + action)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }

    @MainActor
    private func eventually(timeout: Duration = .seconds(45), _ condition: @MainActor () async throws -> Bool) async rethrows -> Bool {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while ContinuousClock.now < deadline {
            if try await condition() { return true }
            try? await Task.sleep(for: .milliseconds(200))
        }
        return false
    }

    @MainActor
    private func interactive(_ label: String, in web: XCUIElement) -> XCUIElement {
        // WebKit exposes aria-pressed buttons as Switch on iOS; ordinary
        // actions remain Button. Keep the semantic interactive-role check.
        web.descendants(matching: .any).matching(NSPredicate(
            format: "label == %@ AND elementType IN %@", label,
            [XCUIElement.ElementType.button.rawValue, XCUIElement.ElementType.switch.rawValue,
             XCUIElement.ElementType.menuItem.rawValue]
        )).firstMatch
    }

    @MainActor
    private func named(_ label: String, in web: XCUIElement) -> XCUIElement {
        // WK exposes Base UI menu triggers as Other rather than Button. Keep
        // those named actions separate from the stricter HTML-task role check.
        web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    @MainActor
    private func snapshot(_ name: String) {
        let image = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        image.name = name
        image.lifetime = .keepAlways
        add(image)
    }
}
