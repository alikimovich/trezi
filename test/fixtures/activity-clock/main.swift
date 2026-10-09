import Foundation

// LKM-147: prints what the live status line shows for fixed stamps, so
// `test/turn-progress.mjs` checks the ticking label and the idle hint.
let now = Date(timeIntervalSince1970: 10_000)
let ms = { (seconds: Double) in (10_000 - seconds) * 1000 }
let cases: [[String: String]] = [
    ["case": "fresh", "label": ChatActivityClock.label("Thinking…", since: ms(1), now: now)],
    ["case": "thinking", "label": ChatActivityClock.label("Thinking…", since: ms(45), now: now)],
    ["case": "tool", "label": ChatActivityClock.label("Running bun test", since: ms(84.6), now: now)],
    ["case": "hour", "label": ChatActivityClock.label("Running bun test", since: ms(3725), now: now)],
    ["case": "unstamped", "label": ChatActivityClock.label("Writing…", since: nil, now: now)],
    ["case": "beating", "idle": ChatActivityClock.idle(aliveAt: ms(5), now: now) ?? ""],
    ["case": "almost", "idle": ChatActivityClock.idle(aliveAt: ms(59), now: now) ?? ""],
    ["case": "stopped", "idle": ChatActivityClock.idle(aliveAt: ms(60), now: now) ?? ""],
    ["case": "long", "idle": ChatActivityClock.idle(aliveAt: ms(185), now: now) ?? ""],
    ["case": "none", "idle": ChatActivityClock.idle(aliveAt: nil, now: now) ?? ""]
]
let data = try JSONSerialization.data(withJSONObject: cases)
print(String(decoding: data, as: UTF8.self))
