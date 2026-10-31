import SwiftUI
import UIKit

/// Keep one native password field alive when revealing its contents so AutoFill
/// does not mistake a replaced SecureField for a submitted login form.
struct PasswordTextField: UIViewRepresentable {
    @Binding var text: String
    var revealed: Bool
    var onSubmit: () -> Void

    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.placeholder = "密码"
        field.textContentType = .password
        field.isSecureTextEntry = !revealed
        field.keyboardType = .asciiCapable
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.returnKeyType = .go
        field.font = .preferredFont(forTextStyle: .body)
        field.adjustsFontForContentSizeCategory = true
        field.textColor = UIColor(named: "Ink")
        field.tintColor = UIColor(named: "AccentColor")
        field.accessibilityIdentifier = "login-password"
        field.accessibilityLabel = "密码"
        field.delegate = context.coordinator
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }

    func updateUIView(_ field: UITextField, context: Context) {
        context.coordinator.parent = self
        field.isEnabled = context.environment.isEnabled
        if field.text != text { field.text = text }
        if field.isSecureTextEntry == revealed {
            let focused = field.isFirstResponder
            let selection = field.selectedTextRange.map {
                (field.offset(from: field.beginningOfDocument, to: $0.start),
                 field.offset(from: field.beginningOfDocument, to: $0.end))
            }
            field.isSecureTextEntry = !revealed
            field.text = text
            if focused {
                field.becomeFirstResponder()
                if let selection,
                   let start = field.position(from: field.beginningOfDocument, offset: selection.0),
                   let end = field.position(from: field.beginningOfDocument, offset: selection.1) {
                    field.selectedTextRange = field.textRange(from: start, to: end)
                }
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    @MainActor
    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: PasswordTextField

        init(_ parent: PasswordTextField) { self.parent = parent }

        @objc func changed(_ field: UITextField) { parent.text = field.text ?? "" }

        func textFieldShouldReturn(_ textField: UITextField) -> Bool {
            parent.onSubmit()
            return false
        }
    }
}
