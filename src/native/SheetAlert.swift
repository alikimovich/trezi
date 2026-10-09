import AppKit
import SwiftUI

/// The keyboard roles of an alert's buttons (LKM-170). Return runs the default: the
/// primary action unless it is destructive, then the cancel button. Esc runs the
/// cancel button: one marked `cancel` (a "Back"), else `cancel` itself.
struct SheetAlertRoles {
    let defaultAction: SheetAction?
    let cancelAction: SheetAction?
    let others: [SheetAction]
    init(_ actions: [SheetAction]) {
        let cancel = actions.first { $0.cancel == true } ?? actions.first { $0.id == "cancel" }
        let primary = actions.first { $0.primary == true && $0.destructive != true }
        cancelAction = cancel
        defaultAction = primary ?? cancel ?? (actions.count == 1 ? actions.first : nil)
        others = actions.filter { $0.id != cancel?.id && $0.id != primary?.id }
    }
    /// What Esc sends; `cancel` with no cancel button, which Bun ignores unless dismissible.
    var escape: String { cancelAction?.id ?? "cancel" }
}

/// An app sheet in the NSAlert sheet layout: app icon, bold message, informative text,
/// optional read-only accessory text, then right-aligned buttons, the default rightmost.
struct SheetAlertContent: View {
    static let width: CGFloat = 448
    @ObservedObject var model: SheetModel
    @ViewBuilder func button(_ action: SheetAction, roles: SheetAlertRoles, busy: Bool) -> some View {
        let base = Button(action.label, role: action.destructive == true ? .destructive : nil) { model.perform(action.id) }
            .disabled(busy && action.id != roles.escape)
        if action.id == roles.defaultAction?.id { base.keyboardShortcut(.defaultAction) }
        else if action.id == roles.cancelAction?.id { base.keyboardShortcut(.cancelAction) }
        else { base }
    }
    var body: some View {
        if let state = model.state {
            let roles = SheetAlertRoles(state.actions)
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 16) {
                    Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 64, height: 64).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 8) {
                        Text(state.title).font(.system(size: 13, weight: .bold)).fixedSize(horizontal: false, vertical: true)
                        if !state.detail.isEmpty {
                            Text(state.detail).font(.system(size: 11)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        }
                        ForEach(state.fields) { field in
                            Text(field.label).font(.system(size: 11, weight: .semibold)).padding(.top, 4)
                            ScrollView {
                                Text(field.value).font(.system(size: 11)).textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading).padding(6)
                            }.frame(height: 120).background(Color(nsColor: .textBackgroundColor))
                                .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color(nsColor: .separatorColor)))
                        }
                        if let message = state.message, !message.isEmpty {
                            Text(message).font(.system(size: 11)).foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                // One row; when the buttons do not fit (four, LKM-220) they stack, the default on top.
                let primary = roles.defaultAction.flatMap { primary in
                    primary.id != roles.cancelAction?.id && !roles.others.contains(where: { $0.id == primary.id }) ? primary : nil
                }
                let row = roles.others + [roles.cancelAction, primary].compactMap { $0 }
                let column = [primary].compactMap { $0 } + roles.others + [roles.cancelAction].compactMap { $0 }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) {
                        if state.busy { ProgressView().controlSize(.small).accessibilityLabel("Working") }
                        Spacer(minLength: 0)
                        ForEach(row) { button($0, roles: roles, busy: state.busy) }
                    }
                    HStack(alignment: .bottom, spacing: 12) {
                        if state.busy { ProgressView().controlSize(.small).accessibilityLabel("Working") }
                        Spacer(minLength: 0)
                        VStack(alignment: .trailing, spacing: 8) { ForEach(column) { button($0, roles: roles, busy: state.busy) } }
                    }
                }.padding(.top, 20).frame(minHeight: 20).background {
                    // Esc when the cancel button is also the default, or there is none.
                    if roles.cancelAction == nil || roles.cancelAction?.id == roles.defaultAction?.id {
                        Button("") { model.perform(roles.escape) }.keyboardShortcut(.cancelAction)
                            .opacity(0).accessibilityHidden(true)
                    }
                }
            }.padding(20).frame(width: Self.width).background(Color(nsColor: .windowBackgroundColor))
        }
    }
}

/// The alert's window: attached to the main window as a sheet, never titled, closable
/// or resizable, and sized to its content.
final class SheetAlertPanel: NSPanel {
    var cancel: (() -> Void)?
    let hosting: NSHostingController<SheetAlertContent>
    init(model: SheetModel) {
        hosting = NSHostingController(rootView: SheetAlertContent(model: model))
        hosting.sizingOptions = []
        super.init(contentRect: NSRect(x: 0, y: 0, width: SheetAlertContent.width, height: 120), styleMask: [.titled, .docModalWindow], backing: .buffered, defer: false)
        isReleasedWhenClosed = false; animationBehavior = .none
        contentViewController = hosting
        fit()
    }
    override var canBecomeKey: Bool { true }
    override func cancelOperation(_ sender: Any?) { cancel?() }
    /// The content's height at the alert's fixed width.
    var idealHeight: CGFloat { ceil(hosting.sizeThatFits(in: NSSize(width: SheetAlertContent.width, height: 10_000)).height) }
    func fit() {
        let height = idealHeight
        if height > 0, contentView?.frame.size != NSSize(width: SheetAlertContent.width, height: height) {
            setContentSize(NSSize(width: SheetAlertContent.width, height: height))
        }
    }
}
