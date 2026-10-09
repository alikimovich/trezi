import Foundation
import CryptoKit
import Security

// Trezi's Keychain helper (LKM-137): `Trezi.app/Contents/Helpers/TreziSecrets`, the only
// process that reads the master key that encrypts connection keys and the Claude token.
// The service runs `TreziSecrets --crypto encrypt|decrypt`; stdin and stdout carry the
// bytes, so no API key or encryption key is ever in argv or a log.
//
// This file is its own executable and should rarely change. The login keychain ties an
// item to the exact binary allowed to read it (for a self-signed or ad hoc signature,
// to its cdhash). A rebuild compiles this file to the same bytes, so the user's "Always
// Allow" survives it. Every edit here costs every user one more Keychain approval.
//
// The key lives in `dev.trezi.native.secrets`. A key under the earlier name is read once,
// written under the new name, and the old item is deleted only after that write worked.
//
// `--keychain <path>` (tests only) uses that keychain file and never shows a prompt.

let service = "dev.trezi.native.secrets"
let legacyService = "dev.praxis.native.secrets"
let account = "master-key"

struct Failure: Error { let status: OSStatus }

let arguments = CommandLine.arguments
guard arguments.count >= 3, arguments[1] == "--crypto", ["encrypt", "decrypt"].contains(arguments[2]) else {
    FileHandle.standardError.write(Data("usage: TreziSecrets --crypto encrypt|decrypt\n".utf8))
    exit(2)
}
let encrypt = arguments[2] == "encrypt"
var keychain: SecKeychain?
if arguments.count == 5, arguments[3] == "--keychain" {
    SecKeychainSetUserInteractionAllowed(false)
    guard SecKeychainOpen(arguments[4], &keychain) == errSecSuccess else { exit(1) }
}

func query(_ name: String) -> [String: Any] {
    var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: name, kSecAttrAccount as String: account]
    if let keychain { query[kSecMatchSearchList as String] = [keychain] }
    return query
}

func read(_ name: String) -> (status: OSStatus, key: Data?) {
    var request = query(name)
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(request as CFDictionary, &item)
    return (status, item as? Data)
}

/// Writes the key under the current name. Its access list trusts this helper by its
/// designated requirement, which a rebuild with the same signing identity keeps.
func store(_ key: Data) -> OSStatus {
    var request = query(service)
    request.removeValue(forKey: kSecMatchSearchList as String)
    if let keychain { request[kSecUseKeychain as String] = keychain }
    request[kSecValueData as String] = key
    var me: SecTrustedApplication?, access: SecAccess?
    if SecTrustedApplicationCreateFromPath(nil, &me) == errSecSuccess, let me,
       SecAccessCreate("Trezi" as CFString, [me] as CFArray, &access) == errSecSuccess, let access {
        request[kSecAttrAccess as String] = access
    }
    return SecItemAdd(request as CFDictionary, nil)
}

func valid(_ key: Data?) throws -> Data {
    guard let key, key.count == 32 else { throw Failure(status: errSecDecode) }
    return key
}

func masterKey(create: Bool) throws -> Data {
    let current = read(service)
    if current.status == errSecSuccess { return try valid(current.key) }
    guard current.status == errSecItemNotFound else { throw Failure(status: current.status) }
    let legacy = read(legacyService)
    if legacy.status == errSecSuccess {
        let key = try valid(legacy.key)
        switch store(key) {
        case errSecSuccess:
            _ = SecItemDelete(query(legacyService) as CFDictionary)
        case errSecDuplicateItem:
            // Another helper migrated at the same time: use what it wrote.
            let written = try valid(read(service).key)
            if written == key { _ = SecItemDelete(query(legacyService) as CFDictionary) }
            return written
        default:
            break // Keep the old item; the next run tries again.
        }
        return key
    }
    guard legacy.status == errSecItemNotFound else { throw Failure(status: legacy.status) }
    guard create else { throw Failure(status: errSecItemNotFound) }
    let fresh = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
    switch store(fresh) {
    case errSecSuccess: return fresh
    case errSecDuplicateItem: return try valid(read(service).key)
    case let status: throw Failure(status: status)
    }
}

do {
    let key = SymmetricKey(data: try masterKey(create: encrypt))
    let input = FileHandle.standardInput.readDataToEndOfFile()
    let output: Data
    if encrypt {
        guard let sealed = try AES.GCM.seal(input, using: key).combined else { exit(1) }
        output = sealed
    } else { output = try AES.GCM.open(AES.GCM.SealedBox(combined: input), using: key) }
    FileHandle.standardOutput.write(output)
    exit(0)
} catch { exit(1) }
