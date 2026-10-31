import Foundation
import Security
import ShardKit

/// Device and GitHub tokens live only in the Keychain, readable after first unlock so a
/// background refresh can still sync.
enum TokenStore {
    private static let service = "dev.shard.mobile.github"
    private static let account = "vault"

    static func load() -> String? {
        load(query: baseQuery)
    }

    static func loadServer(_ server: ServerAccount) -> String? {
        load(query: serverQuery(server))
    }

    private static func load(query: [String: Any]) -> String? {
        var query = query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ token: String) throws {
        try save(token, query: baseQuery)
    }

    static func saveServer(_ token: String, for server: ServerAccount) throws {
        try save(token, query: serverQuery(server))
    }

    private static func save(_ token: String, query: [String: Any]) throws {
        let data = Data(token.utf8)
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(update) { $1 } as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }

    static func delete() {
        SecItemDelete(baseQuery as CFDictionary)
    }

    static func deleteServer(_ server: ServerAccount) {
        SecItemDelete(serverQuery(server) as CFDictionary)
    }

    private static func serverQuery(_ server: ServerAccount) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "dev.shard.mobile.server",
            kSecAttrAccount as String: server.serverURL.absoluteString + "|" + server.email,
        ]
    }

    private static var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
