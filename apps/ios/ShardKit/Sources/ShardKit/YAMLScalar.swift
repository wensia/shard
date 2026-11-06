/// Emits a YAML scalar the way `serde_yaml` 0.9 (libyaml emitter, unicode on) does for
/// a string in block context, so files written on iOS match desktop output byte for byte.
///
/// serde_yaml first single-quotes strings that would otherwise resolve to null, bool,
/// int or float; libyaml then picks plain → single-quoted → double-quoted by analysing
/// the characters (`yaml_emitter_analyze_scalar` / `select_scalar_style`).
enum YAMLScalar {
    static func emit(_ value: String) -> String {
        // serde_yaml switches to a literal block for `\n`; no field we write can contain
        // one (tags stop at whitespace), so fall back to a valid double-quoted scalar.
        if value.contains("\n") {
            return doubleQuoted(value)
        }
        let analysis = analyze(value)
        let forceQuote = resolvesToNonString(value) || digitsButNotNumber(value)
        if !forceQuote, analysis.blockPlainAllowed {
            return value
        }
        return analysis.singleQuotedAllowed ? singleQuoted(value) : doubleQuoted(value)
    }

    // MARK: - serde_yaml implicit resolution (de.rs visit_untagged_scalar)

    static func resolvesToNonString(_ value: String) -> Bool {
        if value.isEmpty || ["~", "null", "Null", "NULL"].contains(value) { return true }
        if ["true", "True", "TRUE", "false", "False", "FALSE"].contains(value) { return true }
        if isInteger(value) { return true }
        return !digitsButNotNumber(value) && isFiniteFloat(value)
    }

    /// Leading zeros followed by digits stay strings in YAML 1.2, yet serde_yaml still quotes them.
    static func digitsButNotNumber(_ value: String) -> Bool {
        var body = Substring(value)
        if let first = body.first, first == "-" || first == "+" { body = body.dropFirst() }
        return body.count > 1 && body.first == "0" && body.dropFirst().allSatisfy(\.isASCIIDigit)
    }

    private static func isInteger(_ value: String) -> Bool {
        var body = Substring(value)
        var negative = false
        if body.first == "+" {
            body = body.dropFirst()
        } else if body.first == "-" {
            body = body.dropFirst()
            negative = true
        }
        for (prefix, digits) in [("0x", "0123456789abcdefABCDEF"), ("0o", "01234567"), ("0b", "01")] where body.hasPrefix(prefix) {
            let rest = body.dropFirst(2)
            return !rest.isEmpty && rest.allSatisfy { digits.contains($0) }
        }
        if body.first == "+" || body.first == "-" { return false }
        if !negative && digitsButNotNumber(value) { return false }
        return !body.isEmpty && body.allSatisfy(\.isASCIIDigit)
    }

    /// Mirrors `parse_f64`: special infinities/NaN, else Rust's `f64::from_str` when finite.
    private static func isFiniteFloat(_ value: String) -> Bool {
        var unpositive = Substring(value)
        if unpositive.first == "+" {
            unpositive = unpositive.dropFirst()
            if unpositive.first == "+" || unpositive.first == "-" { return false }
        }
        if [".inf", ".Inf", ".INF"].contains(unpositive) { return true }
        if ["-.inf", "-.Inf", "-.INF", ".nan", ".NaN", ".NAN"].contains(value) { return true }
        return isRustFiniteDecimal(unpositive)
    }

    /// Rust's float grammar: [+-]? (digits [. digits?] | . digits) ([eE] [+-]? digits)?
    /// (`inf`/`nan` spellings parse but are not finite, so they never count here).
    private static func isRustFiniteDecimal(_ text: Substring) -> Bool {
        var scalars = Array(text.unicodeScalars)[...]
        if let sign = scalars.first, sign == "+" || sign == "-" { scalars = scalars.dropFirst() }
        let integer = scalars.prefix { ("0"..."9").contains($0) }
        scalars = scalars.dropFirst(integer.count)
        var fraction: ArraySlice<Unicode.Scalar> = []
        if scalars.first == "." {
            scalars = scalars.dropFirst()
            fraction = scalars.prefix { ("0"..."9").contains($0) }
            scalars = scalars.dropFirst(fraction.count)
        }
        guard !integer.isEmpty || !fraction.isEmpty else { return false }
        if let marker = scalars.first, marker == "e" || marker == "E" {
            scalars = scalars.dropFirst()
            if let sign = scalars.first, sign == "+" || sign == "-" { scalars = scalars.dropFirst() }
            let exponent = scalars.prefix { ("0"..."9").contains($0) }
            guard !exponent.isEmpty else { return false }
            scalars = scalars.dropFirst(exponent.count)
        }
        return scalars.isEmpty
    }

    // MARK: - libyaml scalar analysis

    struct Analysis {
        var blockPlainAllowed: Bool
        var singleQuotedAllowed: Bool
    }

    static func analyze(_ value: String) -> Analysis {
        let chars = Array(value.unicodeScalars)
        if chars.isEmpty {
            return Analysis(blockPlainAllowed: false, singleQuotedAllowed: true)
        }

        var blockIndicators = false
        var specialCharacters = false
        var lineBreaks = false
        var leadingSpace = false, leadingBreak = false
        var trailingSpace = false, trailingBreak = false
        var breakSpace = false, spaceBreak = false
        var previousSpace = false, previousBreak = false

        if value.hasPrefix("---") || value.hasPrefix("...") {
            blockIndicators = true
        }

        var precededByWhitespace = true
        for (index, char) in chars.enumerated() {
            let isFirst = index == 0
            let isLast = index == chars.count - 1
            let followedByWhitespace = index + 1 >= chars.count || isBlankOrBreak(chars[index + 1])

            if isFirst {
                switch char {
                case "#", ",", "[", "]", "{", "}", "&", "*", "!", "|", ">", "'", "\"", "%", "@", "`":
                    blockIndicators = true
                case "?", ":":
                    if followedByWhitespace { blockIndicators = true }
                case "-":
                    if followedByWhitespace { blockIndicators = true }
                default:
                    break
                }
            } else {
                switch char {
                case ":":
                    if followedByWhitespace { blockIndicators = true }
                case "#":
                    if precededByWhitespace { blockIndicators = true }
                default:
                    break
                }
            }

            if !isPrintable(char) {
                specialCharacters = true
            }
            if isBreak(char) {
                lineBreaks = true
            }

            if char == " " {
                if isFirst { leadingSpace = true }
                if isLast { trailingSpace = true }
                if previousBreak { breakSpace = true }
                previousSpace = true
                previousBreak = false
            } else if isBreak(char) {
                if isFirst { leadingBreak = true }
                if isLast { trailingBreak = true }
                if previousSpace { spaceBreak = true }
                previousSpace = false
                previousBreak = true
            } else {
                previousSpace = false
                previousBreak = false
            }

            precededByWhitespace = isBlankOrBreak(char)
        }

        var blockPlain = true
        var singleQuoted = true
        if leadingSpace || leadingBreak || trailingSpace || trailingBreak { blockPlain = false }
        if breakSpace { blockPlain = false; singleQuoted = false }
        if spaceBreak || specialCharacters { blockPlain = false; singleQuoted = false }
        if lineBreaks { blockPlain = false }
        if blockIndicators { blockPlain = false }
        return Analysis(blockPlainAllowed: blockPlain, singleQuotedAllowed: singleQuoted)
    }

    private static func isBreak(_ char: Unicode.Scalar) -> Bool {
        ["\r", "\n", "\u{85}", "\u{2028}", "\u{2029}"].contains(char)
    }

    private static func isBlankOrBreak(_ char: Unicode.Scalar) -> Bool {
        char == " " || char == "\t" || isBreak(char)
    }

    /// unsafe-libyaml `IS_PRINTABLE` (note: U+0085 is not printable, U+10000+ is).
    private static func isPrintable(_ char: Unicode.Scalar) -> Bool {
        switch char.value {
        case 0x0A, 0x20...0x7E, 0xA0...0xD7FF, 0x10000...0x10FFFF:
            true
        case 0xE000...0xFFFD:
            char.value != 0xFEFF
        default:
            false
        }
    }

    // MARK: - Quoting

    private static func singleQuoted(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "''") + "'"
    }

    /// `yaml_emitter_write_double_quoted_scalar` escapes (line folding past 80 columns,
    /// which only applies to strings with spaces, is not reproduced).
    private static func doubleQuoted(_ value: String) -> String {
        var out = "\""
        for scalar in value.unicodeScalars {
            let needsEscape = !isPrintable(scalar) || scalar == "\u{FEFF}" || isBreak(scalar)
                || scalar == "\"" || scalar == "\\"
            guard needsEscape else {
                out.unicodeScalars.append(scalar)
                continue
            }
            switch scalar.value {
            case 0x00: out += "\\0"
            case 0x07: out += "\\a"
            case 0x08: out += "\\b"
            case 0x09: out += "\\t"
            case 0x0A: out += "\\n"
            case 0x0B: out += "\\v"
            case 0x0C: out += "\\f"
            case 0x0D: out += "\\r"
            case 0x1B: out += "\\e"
            case 0x22: out += "\\\""
            case 0x5C: out += "\\\\"
            case 0x85: out += "\\N"
            case 0xA0: out += "\\_"
            case 0x2028: out += "\\L"
            case 0x2029: out += "\\P"
            case ...0xFF: out += String(format: "\\x%02X", scalar.value)
            case ...0xFFFF: out += String(format: "\\u%04X", scalar.value)
            default: out += String(format: "\\U%08X", scalar.value)
            }
        }
        return out + "\""
    }
}

private extension Character {
    /// Matches Rust `u8::is_ascii_digit` (a combined character never counts).
    var isASCIIDigit: Bool {
        asciiValue.map { (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) } ?? false
    }
}
