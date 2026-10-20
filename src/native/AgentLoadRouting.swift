import Foundation

/// Which WebKit navigation answers an agent browser's pending `open` (LOCAL-WEBKIT-PUBLISH).
/// The page can start navigations of its own (a live-reload `location.reload()`), and WebKit
/// has one main-frame navigation at a time: starting another cancels whichever was in flight,
/// with or without a failure callback for it. Answering the open from "the next callback of
/// that view" let a cancelled navigation (-999) reject or resolve the wrong open. Only the
/// navigation the open started answers it; when another one starts after that, or the open's
/// own is cancelled, the open follows the navigation that took over, and a stale callback
/// changes nothing.
struct AgentLoadRouting {
    enum Outcome { case ignore, reject, wait }

    /// The navigation whose result answers the pending open.
    private(set) var recorded: AnyObject?
    /// The recorded navigation was cancelled and its successor has not started yet.
    private(set) var superseded = false
    /// The recorded navigation reported its start: a different one starting now replaced it.
    private var recordedStarted = false
    /// The most recently started navigation of the view, answered or not.
    private var latest: AnyObject?

    /// The open started `navigation`; nil when it is not known yet (a hard reload clears
    /// caches first and records it when it starts).
    init(_ navigation: AnyObject?) { recorded = navigation }

    mutating func record(_ navigation: AnyObject?) { recorded = navigation; superseded = false; recordedStarted = false; latest = nil }

    mutating func started(_ navigation: AnyObject?) {
        guard let navigation else { return }
        latest = navigation
        if superseded { recorded = navigation; superseded = false; recordedStarted = true; return }
        guard let current = recorded else { return }
        if current === navigation { recordedStarted = true }
        else if recordedStarted { recorded = navigation }
    }

    func finished(_ navigation: AnyObject?) -> Bool {
        guard let recorded, let navigation else { return false }
        return recorded === navigation
    }

    /// `reject`: the open's own navigation failed. `wait`: it was cancelled by another
    /// navigation, which answers the open (it, or the next one to start). `ignore`: a stale
    /// navigation, not this open's.
    mutating func failed(_ navigation: AnyObject?, cancelled: Bool) -> Outcome {
        guard let recorded, let navigation, recorded === navigation else { return .ignore }
        if !cancelled { return .reject }
        if let latest, latest !== navigation { self.recorded = latest; recordedStarted = true } else { self.recorded = nil; superseded = true; recordedStarted = false }
        return .wait
    }
}
