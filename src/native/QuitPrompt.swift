import AppKit

/// LKM-221: a user quit (⌘Q, Quit, the last window, logout or restart) while agents work.
/// Bun decides (`quit-guard.ts`); the host asks it, shows the alert and the progress note,
/// and quits once Bun sends `quitProceed`. Forced quits (signals, a failed service, Bun's
/// own `quit`) never ask.
final class QuitPrompt {
    enum Phase: String { case idle, checking, asking, waiting, stopping, confirmed }
    var phase = Phase.idle
    /// A logout or restart: AppKit waits for `reply(toApplicationShouldTerminate:)`.
    var later = false
    /// Test broker: `quitProceed` is counted instead of quitting.
    var dryRun = false
    var proceeded = 0
    var generation = 0
    var alert: NSAlert?
    var note: QuitNotePanel?
    var escape: Any?
    var lastAnswer = ""
}

/// The small progress note: a spinner, the text and, while waiting, Cancel.
final class QuitNotePanel: NSPanel {
    let spinner = NSProgressIndicator()
    let label = NSTextField(wrappingLabelWithString: "")
    let cancel = NSButton(title: "Cancel", target: nil, action: nil)
    var cancelled: (() -> Void)?
    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 380, height: 60), styleMask: [.titled, .docModalWindow], backing: .buffered, defer: false)
        isReleasedWhenClosed = false; animationBehavior = .none
        spinner.style = .spinning; spinner.controlSize = .small; spinner.startAnimation(nil)
        label.font = .systemFont(ofSize: 12); label.preferredMaxLayoutWidth = 380 - 40 - 16 - 88
        cancel.target = self; cancel.action = #selector(cancelClicked); cancel.keyEquivalent = "\u{1b}"
        let row = NSStackView(views: [spinner, label, cancel])
        row.alignment = .centerY; row.spacing = 10; row.edgeInsets = NSEdgeInsets(top: 16, left: 20, bottom: 16, right: 20)
        label.setContentHuggingPriority(.defaultLow, for: .horizontal)
        contentView = row
    }
    override var canBecomeKey: Bool { true }
    override func cancelOperation(_ sender: Any?) { if !cancel.isHidden { cancelClicked() } }
    @objc func cancelClicked() { cancelled?() }
    func update(_ text: String, cancellable: Bool) {
        label.stringValue = text; cancel.isHidden = !cancellable
        contentView?.layoutSubtreeIfNeeded()
        let height = max(56, ceil(contentView?.fittingSize.height ?? 56))
        setContentSize(NSSize(width: 380, height: height))
    }
}

extension Host {
    /// Logout, restart or shutdown: the quit Apple event carries the system's reason.
    static var systemQuit: Bool {
        guard let event = NSAppleEventManager.shared().currentAppleEvent,
              event.eventID == AEEventID(kAEQuitApplication),
              let reason = event.attributeDescriptor(forKeyword: AEKeyword(kAEQuitReason))?.enumCodeValue else { return false }
        return [kAELogOut, kAEReallyLogOut, kAEShowRestartDialog, kAEShowShutdownDialog, kAERestart, kAEShutDown]
            .map { OSType($0) }.contains(reason)
    }
    /// Whether this quit asks Bun first.
    func quitShouldAsk() -> Bool {
        !quitForced && quit.phase != .confirmed && serviceClient?.isReady == true
    }
    /// The last window's close is a quit: ask first, keeping the window for the alert.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard sender === window, quitShouldAsk() else { return true }
        NSApp.terminate(nil)
        return false
    }
    func requestQuit(later: Bool) -> NSApplication.TerminateReply {
        if later { quit.later = true }
        if quit.phase == .idle {
            quit.phase = .checking; quit.generation += 1
            let generation = quit.generation
            emit(["event": "quit-request"])
            // Bun silent: the quit goes ahead as it did before the check.
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self, self.quit.generation == generation, self.quit.phase == .checking else { return }
                self.quitProceed()
            }
        } else {
            NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil)
        }
        return later ? .terminateLater : .terminateCancel
    }
    /// The top sheet of the main window, so the prompt never queues behind another sheet.
    func quitSheetParent() -> NSWindow {
        var parent: NSWindow = window
        while let sheet = parent.attachedSheet, sheet !== quit.note, sheet !== quit.alert?.window { parent = sheet }
        return parent
    }
    func dismissQuitUI() {
        if let monitor = quit.escape { NSEvent.removeMonitor(monitor); quit.escape = nil }
        if let alert = quit.alert {
            quit.alert = nil
            alert.window.sheetParent?.endSheet(alert.window); alert.window.orderOut(nil)
        }
        if let note = quit.note {
            quit.note = nil
            note.sheetParent?.endSheet(note); note.orderOut(nil)
        }
    }
    func quitProceed() {
        dismissQuitUI()
        if quit.dryRun { quit.dryRun = false; quit.proceeded += 1; quit.phase = .idle; return }
        quit.phase = .confirmed
        if quit.later { replyLaterQuit() } else { NSApp.terminate(nil) }
    }
    /// A logout or restart AppKit is waiting on: drain the service, then let it go on.
    func replyLaterQuit() {
        quit.later = false
        if serviceClient == nil || serviceTerminated { NSApp.reply(toApplicationShouldTerminate: true); return }
        drainService { NSApp.reply(toApplicationShouldTerminate: true) }
    }
    func quitCancelled() {
        dismissQuitUI()
        quit.phase = .idle; quit.generation += 1; quit.dryRun = false
        if quit.later { quit.later = false; NSApp.reply(toApplicationShouldTerminate: false) }
    }
    func quitAnswer(_ choice: String, dontAsk: Bool) {
        quit.lastAnswer = choice
        emit(["event": "quit-answer", "choice": choice, "dontAsk": dontAsk])
        switch choice {
        case "wait": quit.phase = .waiting
        case "stop": enterQuitStopping()
        default: quitCancelled()
        }
    }
    /// Quit Anyway: Bun's wait is bounded (15 s); this bounds it again should Bun go silent.
    func enterQuitStopping() {
        guard quit.phase != .stopping else { return }
        quit.phase = .stopping
        let generation = quit.generation
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            guard let self, self.quit.generation == generation, self.quit.phase == .stopping else { return }
            self.quitProceed()
        }
    }
    func showQuitAlert(title: String, detail: String) {
        guard quit.phase == .checking else { return }
        dismissQuitUI()
        quit.phase = .asking
        let alert = NSAlert()
        alert.messageText = title; alert.informativeText = detail
        // Cancel is the default (Return) and Esc (monitor below). NSAlert gives a button
        // titled "Cancel" Esc instead of Return, so Return is set explicitly.
        alert.addButton(withTitle: "Cancel").keyEquivalent = "\r"
        alert.addButton(withTitle: "Wait and Quit")
        alert.addButton(withTitle: "Quit Anyway")
        alert.showsSuppressionButton = true
        alert.suppressionButton?.title = "Don’t ask again"
        quit.alert = alert
        if window.isMiniaturized { window.deminiaturize(nil) }
        NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil)
        alert.beginSheetModal(for: quitSheetParent()) { [weak self] response in
            guard let self, self.quit.alert === alert else { return }
            self.quit.alert = nil
            if let monitor = self.quit.escape { NSEvent.removeMonitor(monitor); self.quit.escape = nil }
            let choice = response == .alertSecondButtonReturn ? "wait" : response == .alertThirdButtonReturn ? "stop" : "cancel"
            self.quitAnswer(choice, dontAsk: alert.suppressionButton?.state == .on)
        }
        quit.escape = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.keyCode == 53, let alert = self?.quit.alert, event.window === alert.window else { return event }
            alert.buttons.first?.performClick(nil)
            return nil
        }
    }
    func showQuitNote(text: String, cancellable: Bool) {
        // "Don't ask again" goes straight from the check to Quit Anyway's note.
        if quit.phase == .checking { enterQuitStopping() }
        guard quit.phase == .waiting || quit.phase == .stopping else { return }
        if let note = quit.note { note.update(text, cancellable: cancellable); return }
        let note = QuitNotePanel()
        note.update(text, cancellable: cancellable)
        note.cancelled = { [weak self] in self?.quitAnswer("cancel", dontAsk: false) }
        quit.note = note
        quitSheetParent().beginSheet(note)
    }
    func quitInspect() -> [String: Any] {
        var state: [String: Any] = ["phase": quit.phase.rawValue, "later": quit.later, "proceeded": quit.proceeded, "lastAnswer": quit.lastAnswer]
        if let alert = quit.alert {
            state["alert"] = [
                "visible": alert.window.isVisible, "attached": alert.window.sheetParent === window,
                "title": alert.messageText, "text": alert.informativeText,
                "buttons": alert.buttons.map(\.title),
                "defaultButton": alert.buttons.first { $0.keyEquivalent == "\r" }?.title ?? "",
                "escapeButton": quit.escape == nil ? "" : alert.buttons.first?.title ?? "",
                "suppression": alert.suppressionButton?.title ?? "",
                "suppressed": alert.suppressionButton?.state == .on
            ] as [String: Any]
        }
        if let note = quit.note {
            state["note"] = ["visible": note.isVisible, "attached": note.sheetParent === window,
                             "text": note.label.stringValue, "cancellable": !note.cancel.isHidden] as [String: Any]
        }
        return state
    }
    /// Bun's prompt commands and the test broker's quit commands; false: not a quit method.
    func quitCommand(_ c: [String: Any], id: Int) -> Bool {
        switch c["method"] as? String {
        case "quitAsk": showQuitAlert(title: c["title"] as? String ?? "", detail: c["detail"] as? String ?? "")
        case "quitNote": showQuitNote(text: c["text"] as? String ?? "", cancellable: c["cancellable"] as? Bool == true)
        case "quitProceed": if quit.phase != .idle && quit.phase != .confirmed { quitProceed() }
        case "quitInspect": reply(id, quitInspect())
        case "quitRequest":
            // A user quit without quitting: `quitProceed` is counted (test profile only).
            guard ephemeral, quit.phase == .idle else { reply(id, error: "Test profile and idle quit required"); return true }
            quit.dryRun = true
            _ = requestQuit(later: false)
            reply(id, quitInspect())
        case "quitPerform":
            guard ephemeral else { reply(id, error: "Test profile required"); return true }
            let action = c["action"] as? String ?? ""
            if let alert = quit.alert {
                if let dontAsk = c["dontAsk"] as? Bool { alert.suppressionButton?.state = dontAsk ? .on : .off }
                let index = ["cancel": 0, "wait": 1, "stop": 2][action]
                if let index { alert.buttons[index].performClick(nil) }
            } else if action == "cancel", let note = quit.note, !note.cancel.isHidden {
                note.cancel.performClick(nil)
            }
            reply(id, quitInspect())
        case "captureQuit":
            guard let panel = quit.alert?.window ?? quit.note, let content = panel.contentView?.superview else { reply(id, error: "No quit prompt"); return true }
            content.layoutSubtreeIfNeeded(); content.displayIfNeeded()
            guard let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds) else { reply(id, error: "No quit prompt"); return true }
            content.cacheDisplay(in: content.bounds, to: bitmap)
            reply(id, bitmap.representation(using: .png, properties: [:])?.base64EncodedString() ?? "")
        default: return false
        }
        return true
    }
}
