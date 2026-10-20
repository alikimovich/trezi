import Foundation

// Which navigation answers an agent browser's pending open (LOCAL-WEBKIT-PUBLISH), with
// plain objects standing in for WKNavigation: the routing only compares identity.
final class Navigation {}
func check(_ ok: Bool, _ what: String) { precondition(ok, what); print("ok - \(what)") }

do {
    let own = Navigation(), other = Navigation()
    let route = AgentLoadRouting(own)
    check(!route.finished(other), "another navigation finishing does not answer the open")
    check(!route.finished(nil), "a finish without a navigation does not answer it")
    check(route.finished(own), "the open's own navigation answers it")
}
do {
    let own = Navigation(), reload = Navigation()
    var route = AgentLoadRouting(own)
    route.started(reload)
    check(route.failed(own, cancelled: true) == .wait, "the cancel of the open's navigation waits for the one that took over")
    check(route.recorded === reload && !route.superseded, "the navigation that took over (already started) now answers the open")
    check(!route.finished(own) && route.finished(reload), "only the successor finishes the open")
}
do {
    let own = Navigation(), reload = Navigation()
    var route = AgentLoadRouting(own)
    check(route.failed(own, cancelled: true) == .wait, "a cancel before any successor started waits")
    check(route.recorded == nil && route.superseded, "the open is superseded and follows the next navigation")
    check(!route.finished(own), "the cancelled navigation no longer answers")
    route.started(reload)
    check(route.recorded === reload && !route.superseded, "the next navigation to start answers the open")
}
do {
    let own = Navigation(), reload = Navigation()
    var route = AgentLoadRouting(own)
    route.started(own)
    check(route.recorded === own, "the open's own start changes nothing")
    route.started(reload)
    check(route.recorded === reload && !route.finished(own) && route.finished(reload), "a navigation starting after the open's own took over, with no failure callback for the replaced one")
    check(route.failed(own, cancelled: true) == .ignore && route.recorded === reload, "the late cancel of the replaced navigation is stale")
}
do {
    let own = Navigation(), stale = Navigation()
    var route = AgentLoadRouting(own)
    check(route.failed(stale, cancelled: true) == .ignore, "the cancel of a stale navigation is ignored")
    check(route.failed(stale, cancelled: false) == .ignore, "the real failure of a stale navigation is ignored (reported stale)")
    check(route.failed(nil, cancelled: false) == .ignore, "a failure without a navigation is ignored")
    check(route.recorded === own && route.finished(own), "the open is untouched by stale callbacks")
    check(route.failed(own, cancelled: false) == .reject, "the open's own real failure rejects it")
}
do {
    let first = Navigation(), second = Navigation()
    var route = AgentLoadRouting(nil)
    check(!route.finished(first) && route.failed(first, cancelled: false) == .ignore, "a hard reload awaiting its navigation ignores every callback")
    route.record(first)
    check(route.finished(first), "the recorded hard-reload navigation answers the open")
    route.started(second)
    check(route.failed(first, cancelled: true) == .wait && route.recorded === second, "a hard reload superseded by a page navigation follows it")
}
print("AGENT-LOAD-ROUTING OK")
