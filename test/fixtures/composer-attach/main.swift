import AppKit

// LKM-381: the real composer in a window that is never ordered in. The + button's own
// action runs (AX press and click); the chooser presenter is replaced, so no panel appears.
// Prints a JSON report for test/composer-attach.mjs.
_ = NSApplication.shared
var events: [[String: Any]] = []
func emit(_ value: [String: Any]) { events.append(value) }
func copyChatText(_ value: String) {}

let composer = NativeComposer(frame: NSRect(x: 0, y: 0, width: 440, height: 148))
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 148), styleMask: [.titled], backing: .buffered, defer: true)
window.contentView = composer
composer.layoutSubtreeIfNeeded()

var presented: [[String: Any]] = []
var pending: ((NSApplication.ModalResponse, [URL]) -> Void)?
// The panel's options (several files, no folders) are checked by the native smoke.
composer.presentChooser = { sheetWindow, done in
    presented.append(["window": sheetWindow === window, "pending": pending != nil])
    pending = done
}
func attached() -> [String] {
    events.filter { $0["action"] as? String == "files" }
        .flatMap { ($0["files"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String } }
}
func finish(_ result: NSApplication.ModalResponse, _ paths: [String] = []) {
    pending?(result, paths.map { URL(fileURLWithPath: $0) }); pending = nil
}

var report: [String: Any] = ["popUp": composer.plus is NSPopUpButton, "menu": composer.plus.menu != nil,
                             "attachIsPlus": composer.inspect()["attachIsPlus"] as? Bool ?? false]
let inspected = AccessibilityElementInspect.inspect(composer.plus)
report["role"] = inspected["role"]; report["label"] = inspected["label"]; report["axPress"] = inspected["press"]
guard let element = AccessibilityElementInspect.element(of: composer.plus) else { fatalError("no accessibility element") }

// A draft with a .mov attachment, then Cancel twice (AX press, then a click). Files that are
// not images are attached by path, so none is read or written.
let paths = ["clip.mov", "notes.txt", "more.txt"].map { "/composer-attach-fixture/" + $0 }
composer.perform(["text": "Keep this draft", "files": [paths[0]]])
_ = element.accessibilityPerformPress()
report["pressOpens"] = presented.count
finish(.cancel)
composer.plus.performClick(nil)
report["clickOpens"] = presented.count
finish(.cancel)
report["afterCancel"] = ["text": composer.text.string, "attached": attached()]
// OK appends the chosen files after the existing one.
composer.plus.performClick(nil)
finish(.OK, [paths[1], paths[2]])
report["afterAccept"] = ["text": composer.text.string, "attached": attached()]
report["presented"] = presented

// Busy (the sending look): + is disabled and opens nothing; it opens again afterwards.
_ = composer.sending.begin()
RunLoop.main.run(until: Date().addingTimeInterval(ComposerSending.delay + 0.3))
report["busyEnabled"] = composer.plus.isEnabled
composer.plus.performClick(nil); _ = element.accessibilityPerformPress(); composer.chooseFiles(nil)
report["busyOpens"] = presented.count - 3
composer.sending.reset(); composer.renderSending()
composer.plus.performClick(nil)
report["afterBusyOpens"] = presented.count - 3
finish(.cancel)

let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
