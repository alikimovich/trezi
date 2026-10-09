import { MIN_MACOS } from './requirements.mjs'

/**
 * Version keys every bundle carries (LKM-143), from `buildInfo` (scripts/version.mjs):
 * the package version, the commit count as the build number, and the short sha.
 */
const versionKeys = ({ version, build, commit }) => `<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${build}</string>
<key>TreziCommit</key><string>${commit}</string>`

/** Info.plist of `Trezi.app`. */
export function appInfoPlist(info) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.praxis.native</string>
<key>CFBundleName</key><string>Trezi</string>
<key>CFBundleDisplayName</key><string>Trezi</string>
<key>CFBundleIconFile</key><string>Trezi.icns</string>
<key>CFBundleExecutable</key><string>TreziHost</string>
<key>CFBundlePackageType</key><string>APPL</string>
${versionKeys(info)}
<key>LSMinimumSystemVersion</key><string>${MIN_MACOS}</string>
<key>NSHighResolutionCapable</key><true/>
<key>CFBundleDocumentTypes</key><array><dict><key>CFBundleTypeName</key><string>Folder</string><key>CFBundleTypeRole</key><string>Viewer</string><key>LSHandlerRank</key><string>None</string><key>LSItemContentTypes</key><array><string>public.folder</string></array></dict></array>
<key>NSCameraUsageDescription</key><string>Allow your local project preview to test camera features when you approve.</string>
<key>NSMicrophoneUsageDescription</key><string>Allow your local project preview to test microphone features when you approve.</string>
</dict></plist>`
}

/**
 * Info.plist of the XPC service (`Trezi.app/Contents/XPCServices/dev.trezi.service.xpc`).
 *
 * `JoinExistingSession` (LKM-125): without it launchd starts the service in a new
 * security session, which has no login keychain. Every process the service starts
 * (Bun, the `TreziSecrets --crypto` Keychain helper, provider helpers and the Claude CLI)
 * inherits that session, so saving a key failed with "Keychain encryption unavailable"
 * and a `claude auth login` from Terminal read as logged out. With it the service runs
 * in the host's session, like the host started from Terminal or by `open -a`.
 */
export function serviceInfoPlist(info) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.trezi.service</string>
<key>CFBundleName</key><string>Trezi Service</string>
<key>CFBundleExecutable</key><string>TreziService</string>
<key>CFBundlePackageType</key><string>XPC!</string>
${versionKeys(info)}
<key>XPCService</key><dict><key>ServiceType</key><string>Application</string><key>RunLoopType</key><string>dispatch_main</string><key>JoinExistingSession</key><true/></dict>
</dict></plist>`
}
