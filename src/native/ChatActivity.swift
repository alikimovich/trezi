import SwiftUI

struct ChatActivityState: Decodable {
    let label: String
    /// The label with full paths when `label` is collapsed.
    let detail: String?
    let kind: String
    let animated: Bool
    /// Epoch ms: the current step's start and the turn's last event or heartbeat (LKM-147).
    let since: Double?
    let aliveAt: Double?
    /// The running turn's counter, on its own line under the status (LKM-145).
    let tokens: ChatTokens?
}

/// The status lines the conversation rendered, as shown this second (for inspection).
struct ChatStatusLines: PreferenceKey {
    static var defaultValue: [String] = []
    static func reduce(value: inout [String], nextValue: () -> [String]) { value += nextValue() }
}

/// One live status at the tail of the active response, never in past messages. A
/// local one-second clock appends the step's elapsed time and, once events and
/// heartbeats have stopped for a minute, a "No activity for N min" hint (LKM-147).
struct ChatActivity: View {
    let activity: ChatActivityState
    let visible: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var onscreen = false

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { clock in
            let label = ChatActivityClock.label(activity.label, since: activity.since, now: clock.date)
            let idle = ChatActivityClock.idle(aliveAt: activity.aliveAt, now: clock.date)
            let animating = visible && onscreen && activity.animated && !reduceMotion && idle == nil
            HStack(spacing: 6) {
                ZStack(alignment: .leading) {
                    TimelineView(.animation(minimumInterval: 1 / 30, paused: !animating)) { timeline in
                        let phase = timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2) / 2
                        Text(label).foregroundStyle(.secondary)
                            .overlay {
                                if animating {
                                    Text(label).foregroundStyle(.primary)
                                        .mask {
                                            GeometryReader { geometry in
                                                LinearGradient(colors: [.clear, .white, .clear], startPoint: .leading, endPoint: .trailing)
                                                    .frame(width: 55)
                                                    .offset(x: phase * (geometry.size.width + 110) - 55)
                                            }
                                        }
                                }
                            }
                    }
                    .monospacedDigit().lineLimit(1).truncationMode(.tail).help(activity.detail ?? activity.label)
                    // Keyed by the step, not the ticking text: only a new step swaps.
                    .id(activity.label)
                    .transition(reduceMotion ? .identity : .asymmetric(
                        insertion: .modifier(active: ActivitySwap(offset: 8, blur: 2, opacity: 0), identity: ActivitySwap()),
                        removal: .modifier(active: ActivitySwap(offset: -8, blur: 2, opacity: 0), identity: ActivitySwap())))
                }.animation(reduceMotion ? nil : .easeInOut(duration: 0.15), value: activity.label)
                if let idle {
                    Text(idle).foregroundStyle(.orange).lineLimit(1).fixedSize()
                        .help("Nothing has arrived from this turn, not even the provider’s heartbeat. It may be stuck; Stop ends it.")
                }
            }
            .font(.system(size: 12))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel([label, idle].compactMap { $0 }.joined(separator: ", "))
            .preference(key: ChatStatusLines.self, value: [[label, idle].compactMap { $0 }.joined(separator: " · ")])
        }
        .onAppear { onscreen = true }
        .onDisappear { onscreen = false }
    }
}

/// A turn's token counter and its tooltip, formatted by `chat-snapshot.ts`.
struct ChatTokens: Decodable { let label: String; let detail: String }

struct TurnFooterPositions: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) { value.merge(nextValue()) { _, new in new } }
}
/// Messages whose Copy/Revert row is currently revealed, for inspection.
struct RevealedActions: PreferenceKey {
    static var defaultValue: [String] = []
    static func reduce(value: inout [String], nextValue: () -> [String]) { value += nextValue() }
}

/// The tail of an assistant response (or of a turn with no response yet). While it
/// runs: the one live status line, and the turn's counter on its own line under it
/// (LKM-145). Once done: the Copy/Revert row. The latest response keeps the
/// counter's line empty, so completion moves nothing; older ones are one 28 pt
/// row (LKM-149, see ChatLayout.footerHeight).
struct ChatTurnFooter<Actions: View>: View {
    let id: String
    let activity: ChatActivityState?
    var latest = true
    let visible: Bool
    @ViewBuilder let actions: () -> Actions
    var body: some View {
        VStack(alignment: .leading, spacing: ChatLayout.footerCountSpacing) {
            HStack(spacing: 8) {
                if let activity { ChatActivity(activity: activity, visible: visible) } else { actions() }
            }.frame(height: ChatLayout.footerRowHeight, alignment: .leading)
            if ChatLayout.footerReservesCount(running: activity != nil, latest: latest) {
                Group {
                    if let tokens = activity?.tokens { ChatTokenCount(id: id, tokens: tokens) } else { Color.clear.frame(width: 1) }
                }.frame(height: ChatLayout.footerCountHeight, alignment: .leading)
            }
        }.frame(height: ChatLayout.footerHeight(running: activity != nil, latest: latest), alignment: .top)
        .background(GeometryReader { geometry in
            Color.clear.preference(key: TurnFooterPositions.self, value: [id: geometry.frame(in: .named("chatScroll"))])
        })
    }
}

private struct ChatTokenCount: View {
    let id: String
    let tokens: ChatTokens
    var body: some View {
        Text(tokens.label).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
            .lineLimit(1).fixedSize().help(tokens.detail)
            .accessibilityLabel(tokens.detail)
            .background(GeometryReader { geometry in
                Color.clear.preference(key: TurnFooterPositions.self, value: ["\(id)-tokens": geometry.frame(in: .named("chatScroll"))])
            })
    }
}

private struct ActivitySwap: ViewModifier {
    var offset: CGFloat = 0
    var blur: CGFloat = 0
    var opacity: Double = 1
    func body(content: Content) -> some View {
        content.offset(y: offset).blur(radius: blur).opacity(opacity)
    }
}
