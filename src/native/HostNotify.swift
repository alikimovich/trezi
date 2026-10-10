import AppKit
import UserNotifications

/// LKM-228: the optional macOS notification for a CI failure after Publish. Bun decides
/// whether to ask (Settings: Auto-fix CI failures is not Off); the host only posts it,
/// and only while Trezi is in the background (the in-app toast covers the foreground).
/// Authorization is requested lazily, on the first notification, never at launch, and
/// never in a test run (a permission prompt would block the machine). The two actions
/// route back as `ci-notification` events to the same handlers as the toast.
final class CINotifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = CINotifier()
    private static let category = "dev.trezi.ci-failed"
    private var configured = false

    private var available: Bool {
        Bundle.main.bundleIdentifier != nil && HostLaunch.environment["TREZI_NATIVE_TEST_DIR"] == nil
    }

    func post(_ c: [String: Any]) {
        guard available, !NSApp.isActive, let title = c["title"] as? String, !title.isEmpty else { return }
        let center = UNUserNotificationCenter.current()
        if !configured {
            configured = true
            center.delegate = self
            center.setNotificationCategories([UNNotificationCategory(identifier: Self.category, actions: [
                UNNotificationAction(identifier: "fix", title: "Fix with agent", options: [.foreground]),
                UNNotificationAction(identifier: "view", title: "View checks", options: [.foreground])
            ], intentIdentifiers: [], options: [])])
        }
        let root = c["root"] as? String ?? ""
        let body = c["body"] as? String ?? ""
        center.requestAuthorization(options: [.alert]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = title; content.body = body
            content.categoryIdentifier = Self.category
            content.userInfo = ["root": root]
            center.add(UNNotificationRequest(identifier: "ci-failed:" + root, content: content, trigger: nil))
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let action = response.actionIdentifier == "fix" || response.actionIdentifier == "view" ? response.actionIdentifier : "view"
        let root = response.notification.request.content.userInfo["root"] as? String ?? ""
        DispatchQueue.main.async { emit(["event":"ci-notification", "action":action, "root":root]) }
        completionHandler()
    }
}

extension Host {
    func notifyCommand(_ c: [String: Any]) -> Bool {
        guard c["method"] as? String == "notify" else { return false }
        CINotifier.shared.post(c)
        return true
    }
}
