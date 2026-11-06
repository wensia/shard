import ShardKit
import SwiftUI

/// Quick capture, the phone's counterpart of the desktop capture box. The draft survives
/// dismissal; sending queues the fragment so it works offline.
struct ComposeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @AppStorage("composeDraft") private var draft = ""
    @FocusState private var focused: Bool
    @State private var errorMessage: String?
    @State private var isSending = false

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                ZStack(alignment: .topLeading) {
                    if draft.isEmpty {
                        Text("想到什么，写什么…")
                            .foregroundStyle(Theme.mutedInk)
                            .padding(.top, 8)
                            .padding(.leading, 5)
                            .allowsHitTesting(false)
                    }
                    TextEditor(text: $draft)
                        .focused($focused)
                        .scrollContentBackground(.hidden)
                        .foregroundStyle(Theme.ink)
                        .accessibilityIdentifier("compose-editor")
                }
                .font(.body)

                let tags = ShardTags.captureTags(for: draft).filter { $0 != ShardTags.inbox }
                if !tags.isEmpty {
                    Text(tags.map { "#\($0)" }.joined(separator: "  "))
                        .font(.subheadline)
                        .foregroundStyle(Theme.tagInk)
                }
                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(Theme.accent)
                }
            }
            .padding(16)
            .background(Theme.canvas)
            .navigationTitle("记一条")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("发送") { Task { await send() } }
                        .disabled(isBlank || isSending)
                        .accessibilityIdentifier("compose-send")
                }
                ToolbarItemGroup(placement: .keyboard) {
                    // `#` hides behind the symbol page on the Chinese keyboard.
                    Button("#") { appendTagMarker() }
                        .font(.body.weight(.semibold))
                    Spacer()
                }
            }
            .onAppear { focused = true }
        }
    }

    private var isBlank: Bool {
        draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func appendTagMarker() {
        if let last = draft.last, !last.isWhitespace {
            draft += " "
        }
        draft += "#"
    }

    private func send() async {
        isSending = true
        defer { isSending = false }
        do {
            try await model.capture(draft)
            draft = ""
            dismiss()
        } catch {
            errorMessage = AppModel.describe(error)
        }
    }
}
