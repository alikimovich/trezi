import AppKit

/// LKM-672: one unmodified Escape leaves the preview's current mode. Each mode keeps its one
/// owner: Mark up's overlay (`PreviewMarkup.escape`), the page's own Select key path in
/// `src/preview/preload.ts` while the preview has the keys, and, when nothing in the window
/// has the keys, the toolbar's own Select action here. Chat, source, Styles and Layers keep
/// their Escape; a sheet, menu or colour panel gets it first because it is not this window's.
/// Where the last bare Escape went, for the native smoke: it waits on the count, not a timer.
private var previewEscapeTrail: (count: Int, route: String) = (0, "")

extension Host {
    /// The host's one Escape stop for the preview modes, after 3D's own (`closeThreeDOnEscape`).
    /// True when a mode took the key; otherwise it goes on to whatever holds the focus.
    func previewEscape() -> Bool {
        let route = markupTakesKeys && markup?.escape() == true ? "markup" : exitSelectOnEscape() ? "select" : "passed"
        previewEscapeTrail = (previewEscapeTrail.count + 1, route)
        return route != "passed"
    }
    var previewEscapeInspect: [String: Any] { ["count":previewEscapeTrail.count, "route":previewEscapeTrail.route] }
    /// The window's keys rest on nothing in particular: no field, list or page has them.
    var previewKeysUnclaimed: Bool {
        guard let responder = window.firstResponder else { return true }
        return responder === window || responder === window.contentView || responder === canvas
    }
    /// Escape with Select on and no other owner: the same toggle as the top bar button, so
    /// the toolbar, the Bun state and the page's select mode change together.
    @discardableResult func exitSelectOnEscape() -> Bool {
        guard shell.selecting, NSApp.keyWindow === window, window.attachedSheet == nil, !menuTracking,
              !threeD.active, markup?.overlay?.isHidden != false, previewKeysUnclaimed else { return false }
        return shell.perform("select-object", id: nil)
    }
}

enum PreviewEscape {
    /// Only a bare Escape: ⌘. and modified Escapes keep their own meaning.
    static func plain(_ event: NSEvent) -> Bool {
        event.type == .keyDown && event.keyCode == 53 && event.modifierFlags.intersection([.command, .option, .control, .shift]).isEmpty
    }
}
