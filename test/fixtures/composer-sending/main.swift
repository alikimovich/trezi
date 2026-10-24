import Foundation

// The composer's sending state (LKM-338) with a scheduler the fixture fires by hand: no
// window, no real 1.5 s wait.
func check(_ ok: Bool, _ what: String) { precondition(ok, what); print("ok - \(what)") }
var scheduled: [(TimeInterval, DispatchWorkItem)] = []
func elapse() { let due = scheduled; scheduled = []; for (_, work) in due where !work.isCancelled { work.perform() } }
let sending = ComposerSending(schedule: { scheduled.append(($0, $1)) })
var redraws = 0
sending.changed = { redraws += 1 }

// A send that leaves within 1.5 s: no look at any point, and the late timer does nothing.
let quick = sending.begin()
check(scheduled.first?.0 == 1.5, "the delay is 1.5 s")
check(sending.look == nil, "nothing changes at the press")
sending.update(["attempt": quick, "active": false])
elapse()
check(sending.look == nil && sending.pending == nil && redraws == 0, "a send that left in time never shows sending")

// A held send: after 1.5 s the beam look, Stop while the controller can cancel it.
let slow = sending.begin()
sending.update(["attempt": quick, "active": false]) // a snapshot from before the press
check(sending.pending == slow && !sending.cancellable, "an older snapshot does not end the new send")
sending.update(["attempt": slow, "active": true])
check(sending.look == nil, "held, but not 1.5 s yet")
elapse()
check(redraws == 1, "the composer redraws when the delay passes")
check(sending.look == ComposerSending.Look(stop: true, label: "Stop sending", symbol: "stop.fill", contentAlpha: 0.55),
      "Stop sending, stop.fill, content at 55%")
// Stop: the controller ends the hold; the composer is back to the snapshot's own controls.
sending.update(["attempt": slow, "active": false])
check(sending.look == nil && sending.pending == nil, "Stop returns to the normal composer")

// Not yet acknowledged by the controller after 1.5 s: shimmer only, no Stop.
let lagging = sending.begin()
elapse()
check(sending.look == ComposerSending.Look(stop: false, label: "Sending…", symbol: "arrow.up", contentAlpha: 0.55),
      "a send the controller has not reached shows Sending… without Stop")
sending.update(["attempt": lagging, "active": true])
check(sending.look?.stop == true, "Stop appears once the controller holds it")
sending.update(["attempt": lagging, "active": false])
check(sending.look == nil, "the draft left: back to normal")

// Attempts increase across chats; a chat switch drops the pending send.
let next = sending.begin()
check(next > lagging, "attempts only increase")
sending.reset()
elapse()
check(sending.look == nil && redraws == 2, "a reset cancels the delay")
