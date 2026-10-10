import AppKit

final class ChatToolbarView: NSView {
    var align: (() -> Void)?
    override func layout() {
        super.layout()
        // Wait for AppKit to place all toolbar items before measuring in window coordinates.
        DispatchQueue.main.async { [weak self] in self?.align?() }
    }
}

/// System sidebar, split-view divider and toolbar. Web content uses detail-local
/// coordinates, so existing preview/inspector geometry remains unchanged.
final class NativeShell: NSObject, NSOutlineViewDataSource, NSOutlineViewDelegate, NSToolbarDelegate, NSMenuDelegate, NSTextFieldDelegate {
    let split = NSSplitViewController()
    let outline = NSOutlineView()
    let sidebar = NSViewController()
    private let contentCanvas: NSView
    var sidebarItem: NSSplitViewItem!
    var rows: [ShellRow] = []
    private var rowsSignature = Data()
    var currentProject: String?
    var selectedID: String?
    let selection = ShellSelection()
    var applying = false
    var ready = false
    var selecting = false
    var chatHidden = false
    /// The selected project finished opening; the chat header's title and actions show only then.
    var chatReady = false
    /// What the chat gate shows in the header, merged into `shellInspect`.
    func gateInspect() -> [String: Any] { ["chatReady":chatReady, "chatHeaderContentVisible":!chatActions.isHidden || !chatTitle.isHidden] }
    /// A toolbar button's control and its rect in it, to anchor a popover or menu (LKM-229).
    func toolbarButtonAnchor(_ key: String) -> (view: NSView, rect: NSRect)? {
        toolbar?.items.compactMap { $0 as? MomentaryToolbarGroup }.lazy.compactMap { $0.segmentAnchor(key) }.first
    }
    /// A toolbar button's frame in the main window's coordinates, e.g. to hang the Layers
    /// island under it. In full screen the toolbar is another window: convert via the screen.
    func toolbarButtonFrame(_ key: String) -> NSRect? {
        guard let (view, rect) = toolbarButtonAnchor(key), let source = view.window else { return nil }
        let frame = view.convert(rect, to: nil)
        guard let window, source !== window else { return frame }
        return window.convertFromScreen(source.convertToScreen(frame))
    }
    var toolbar: NSToolbar!
    private var toolbarLayout: ToolbarLayout!
    weak var window: NSWindow?
    private(set) var toolbarItems: [String: NSToolbarItem] = [:]
    private let items = [ "chat", "address", "interaction", "select-object", "device", "overlay", "speed", "tools", "code", "layers", "expand", "more", "publish"]
    private let labels = ["select-object":"Select Object", "layers":"Show Layers", "home":"Back to Project", "address":"Preview Address", "device":"Switch to Mobile", "overlay":"Rulers and Grids", "branch":"Branch", "publish":"Publish", "code":"Show Code", "expand":"Expand Preview", "speed":"Slow Motion", "more":"More Preview Actions"]
    private let symbols = ["select-object":"cursorarrow", "layers":"square.3.layers.3d", "home":"house", "device":"iphone", "overlay":"ruler", "branch":"arrow.triangle.branch", "publish":"arrow.up.circle", "code":"chevron.left.forwardslash.chevron.right", "expand":"arrow.up.left.and.arrow.down.right"]
    /// The rulers-and-grids button opens its native popover (LKM-205) instead of asking main.
    var overlayAction: (() -> Void)?
    private(set) var sidebarButtons: [String: NSButton] = [:]
    private var previewState: [String: Any] = [:]
    private var sidebarBeforeExpand = false
    let chatHeader = ChatToolbarView()
    private let chatTitle = NSTextField(labelWithString: "Chat")
    private let chatActions = ChatToolbarActions(frame: .zero)
    // The address block and its layout (`ToolbarAddress.swift`).
    var addressWidth: NSLayoutConstraint?
    var addressLayout = ToolbarAddressLayout()
    /// How far the groups before "…" move when it leaves or joins the toolbar (`ToolbarMore.swift`):
    /// measured from the laid-out items when AppKit's item views can be read, else this estimate
    /// (macOS 26; the layout check allows ±1).
    var moreShift: CGFloat = 46
    let addressHeader = ToolbarAddressView()
    private var chatHeaderWidth: NSLayoutConstraint!
    private var previewTextColor = NSColor.labelColor
    let address = NSTextField()
    let branchMenu = BranchPopUpButton(frame: .zero, pullsDown: true)
    private var branchAnimation: Timer?
    private var branchAnimationPhase = 0
    private var branchAnimationTitle = ""
    let statesMenu = NSPopUpButton(frame: .zero, pullsDown: true)
    var statesMenuConstraints: [NSLayoutConstraint] = []
    var publishTitle = "Publish"
    let publishSpinner = ToolbarPublishSpinner()
    /// Toolbar frames read synchronously inside the last `window-width` test resize.
    var resizeSnapshot: [String: Any] = [:]

    init(window: NSWindow, canvas: NSView) {
        contentCanvas = canvas
        super.init(); self.window = window
        split.splitView.isVertical = true
        split.view.frame = window.contentLayoutRect
        SourceList.configure(outline, label: "Projects")
        outline.allowsEmptySelection = true
        outline.dataSource = self; outline.delegate = self
        outline.registerForDraggedTypes([.treziProject])
        outline.setDraggingSourceOperationMask(.move, forLocal: true)
        let menu = NSMenu(); menu.delegate = self; outline.menu = menu
        let scroll = SourceList.scrollView(outline)
        let sidebarContainer = NSView()
        let projectActions = NSStackView()
        projectActions.orientation = .vertical; projectActions.alignment = .leading; projectActions.spacing = 2
        for (title, symbol, action) in [("Open Project…", "folder", "open-project"), ("New Project…", "plus", "new-project")] {
            let button = SidebarProjectButton(title: title, target: self, action: #selector(sidebarAction(_:)))
            button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
            button.identifier = NSUserInterfaceItemIdentifier(action)
            button.isBordered = false; button.setButtonType(.momentaryChange)
            button.setAccessibilityLabel(title)
            projectActions.addArrangedSubview(button)
            button.widthAnchor.constraint(equalTo: projectActions.widthAnchor).isActive = true
            button.heightAnchor.constraint(equalToConstant: SidebarRowStyle.height).isActive = true
            sidebarButtons[action] = button
        }
        // Settings opens from Trezi → Settings… (Command-,), not from the sidebar.
        for view in [projectActions, scroll] { view.translatesAutoresizingMaskIntoConstraints = false; sidebarContainer.addSubview(view) }
        NSLayoutConstraint.activate([
            projectActions.topAnchor.constraint(equalTo: sidebarContainer.safeAreaLayoutGuide.topAnchor, constant: 8),
            projectActions.leadingAnchor.constraint(equalTo: sidebarContainer.leadingAnchor, constant: 10),
            projectActions.trailingAnchor.constraint(equalTo: sidebarContainer.trailingAnchor, constant: -10),
            scroll.topAnchor.constraint(equalTo: projectActions.bottomAnchor, constant: 16), scroll.leadingAnchor.constraint(equalTo: sidebarContainer.leadingAnchor), scroll.trailingAnchor.constraint(equalTo: sidebarContainer.trailingAnchor), scroll.bottomAnchor.constraint(equalTo: sidebarContainer.bottomAnchor, constant: -BuildBadge.footerHeight)
        ])
        sidebar.view = sidebarContainer
        sidebarItem = SourceList.sidebarItem(sidebar, minimum: 180, maximum: 340)
        sidebarItem.canCollapse = true
        sidebarItem.collapseBehavior = .preferResizingSiblingsWithFixedSplitView
        let detail = NSViewController(); detail.view = NSView()
        // Full-size content lets the sidebar material surround the window controls.
        // Keep WebKit's coordinate space below the toolbar, as before.
        canvas.translatesAutoresizingMaskIntoConstraints = false
        detail.view.addSubview(canvas)
        NSLayoutConstraint.activate([
            canvas.topAnchor.constraint(equalTo: detail.view.safeAreaLayoutGuide.topAnchor),
            canvas.bottomAnchor.constraint(equalTo: detail.view.bottomAnchor),
            canvas.leadingAnchor.constraint(equalTo: detail.view.leadingAnchor),
            canvas.trailingAnchor.constraint(equalTo: detail.view.trailingAnchor)
        ])
        split.addSplitViewItem(sidebarItem)
        let detailItem = NSSplitViewItem(viewController: detail)
        detailItem.minimumThickness = 500
        detailItem.allowsFullHeightLayout = true
        split.addSplitViewItem(detailItem)
        window.contentViewController = split
        split.splitView.setPosition(230, ofDividerAt: 0)
        toolbar = NSToolbar(identifier: "TreziNativePreviewToolbar")
        toolbar.delegate = self; toolbar.displayMode = .iconOnly
        toolbar.allowsUserCustomization = false; toolbar.autosavesConfiguration = false
        chatHeader.align = { [weak self] in self?.measureToolbar() }
        addressHeader.measure = { [weak self] in self?.measureToolbar() }
        NotificationCenter.default.addObserver(self, selector: #selector(splitResized(_:)), name: NSSplitView.didResizeSubviewsNotification, object: split.splitView)
        // Window resizes set the toolbar widths synchronously, in the same layout pass.
        NotificationCenter.default.addObserver(self, selector: #selector(windowResized(_:)), name: NSWindow.didResizeNotification, object: window)
        NotificationCenter.default.addObserver(self, selector: #selector(splitResized(_:)), name: NSWindow.didEndLiveResizeNotification, object: window)
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.titleVisibility = .hidden
        window.toolbar = toolbar; window.toolbarStyle = .unified
        toolbarLayout = ToolbarLayout(toolbar: toolbar, sidebar: sidebarItem)
    }
    @objc private func splitResized(_ notification: Notification) {
        DispatchQueue.main.async { [weak self] in self?.measureToolbar() }
    }
    func updatePreviewColor(_ color: NSColor) {
        guard let rgb = color.usingColorSpace(.sRGB) else { return }
        func linear(_ value: CGFloat) -> CGFloat { value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4) }
        let luminance = 0.2126 * linear(rgb.redComponent) + 0.7152 * linear(rgb.greenComponent) + 0.0722 * linear(rgb.blueComponent)
        let dark = luminance < 0.179
        previewTextColor = dark ? .white : .black
        let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        address.superview?.appearance = appearance
        address.textColor = previewTextColor
        if let editor = address.currentEditor() as? NSTextView {
            editor.textColor = previewTextColor; editor.insertionPointColor = previewTextColor
        }
        if let first = branchMenu.menu?.items.first { first.attributedTitle = branchTitle(first.title) }
    }
    private func branchTitle(_ title: String) -> NSAttributedString {
        let style = NSMutableParagraphStyle(); style.lineBreakMode = .byTruncatingTail
        let result = NSMutableAttributedString(string: title, attributes: [.foregroundColor:previewTextColor, .font:NSFont.systemFont(ofSize: NSFont.smallSystemFontSize), .paragraphStyle:style])
        let ci = (previewState["branchStatus"] as? [String: Any])?["ci"] as? String ?? ""
        let color: NSColor = ci == "failed" ? .systemRed : ci == "passed" ? .systemGreen : .systemOrange
        for dot in ["●", "◌"] {
            let range = (title as NSString).range(of: dot)
            if range.location != NSNotFound { result.addAttribute(.foregroundColor, value: color, range: range) }
        }
        return result
    }
    private func animateBranch(_ title: String, active: Bool) {
        branchAnimationTitle = title
        if !active || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            branchAnimation?.invalidate(); branchAnimation = nil
            return
        }
        guard branchAnimation == nil else { return }
        let timer = Timer(timeInterval: 0.55, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.branchAnimationPhase = (self.branchAnimationPhase + 1) % 3
            let arrow = ["↗", "→", "↑"][self.branchAnimationPhase]
            let dot = self.branchAnimationPhase == 1 ? "◌" : "●"
            let title = self.branchAnimationTitle.replacingOccurrences(of: "↗", with: arrow).replacingOccurrences(of: "◌", with: dot)
            self.branchMenu.menu?.items.first?.attributedTitle = self.branchTitle(title)
        }
        RunLoop.main.add(timer, forMode: .common)
        branchAnimation = timer
    }
    func setChatGeometry(_ width: CGFloat) { previewState["chatWidth"] = Double(width); alignChatHeader() }
    var previewLeading: CGFloat { CGFloat(previewState["chatWidth"] as? Double ?? 440) }
    /// The chat header follows the chat column; the address block fills the rest (`ToolbarAddressLayout`).
    func alignChatHeader() {
        let windowWidth = window?.frame.width ?? 1320
        fitMore(windowWidth: windowWidth)
        var chatTrailing: CGFloat?
        if chatHeader.window != nil, chatHeaderWidth != nil {
            let detail = split.splitViewItems[1].viewController.view
            let target = detail.convert(.zero, to: nil).x + (previewState["chatWidth"] as? Double ?? 440)
            let leading = chatHeader.convert(.zero, to: nil).x
            let width = min(max(100, target - leading), max(100, addressLayout.chatLimit(windowWidth: windowWidth, chatLeading: leading)))
            chatTitle.isHidden = !chatReady || chatHidden || width < 150
            if abs(chatHeaderWidth.constant - width) > 0.5 { chatHeaderWidth.constant = width }
            chatTrailing = leading + width
            let formerChat = min(max(100, target - leading), max(100, windowWidth - leading - 500))
            addressLayout.formerWidth = min(180, max(80, windowWidth - leading - formerChat - 400))
        }
        guard let addressWidth else { return }
        let width = addressLayout.width(windowWidth: windowWidth, chatTrailing: chatTrailing)
        if abs(addressWidth.constant - width) > 0.5 { addressWidth.constant = width }
    }
    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.toggleSidebar, .sidebarTrackingSeparator, .flexibleSpace, .space] + items.map { NSToolbarItem.Identifier($0) }
    }
    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        // LKM-213: Publish is always the last item, at the trailing edge; "…" goes before it.
        [.toggleSidebar, .sidebarTrackingSeparator, NSToolbarItem.Identifier("address"), .flexibleSpace,
         NSToolbarItem.Identifier("interaction"), .space, NSToolbarItem.Identifier("tools"), .space, NSToolbarItem.Identifier("more"), NSToolbarItem.Identifier("publish")]
    }
    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier identifier: NSToolbarItem.Identifier, willBeInsertedIntoToolbar: Bool) -> NSToolbarItem? {
        let key = identifier.rawValue
        guard items.contains(key) else { return nil }
        if key == "chat" || key == "address", let existing = toolbarItems[key] { return existing }
        if key == "tools" || key == "interaction" {
            let actions = key == "tools" ? ["code", "layers", "expand"] : ["select-object", "device", "overlay", "speed"]
            let children = actions.compactMap {
                self.toolbar(toolbar, itemForItemIdentifier: NSToolbarItem.Identifier($0), willBeInsertedIntoToolbar: willBeInsertedIntoToolbar)
            }
            let group = MomentaryToolbarGroup(identifier: identifier, items: children)
            group.label = key == "tools" ? "Preview Tools" : "Preview Interaction"
            group.isBordered = true; group.visibilityPriority = .high
            return group
        }
        let item: NSToolbarItem = ["branch", "publish", "speed", "more"].contains(key) ? NSMenuToolbarItem(itemIdentifier: identifier) : NSToolbarItem(itemIdentifier: identifier)
        item.label = labels[key] ?? key; item.paletteLabel = item.label; item.toolTip = item.label
        item.image = toolbarSymbol(symbols[key] ?? "circle", item.label)
        // Menu-only items let AppKit open the menu from the entire control.
        if !["branch", "chat", "address", "speed", "more"].contains(key) { item.target = self; item.action = #selector(toolbarAction(_:)) }
        if key == "more", let menuItem = item as? NSMenuToolbarItem { configureMore(menuItem) }
        if key == "speed", let menuItem = item as? NSMenuToolbarItem { toolbarItems[key] = item; configureSpeed(menuItem) }
        if key == "chat" {
            chatHeader.translatesAutoresizingMaskIntoConstraints = false
            chatHeaderWidth = chatHeader.widthAnchor.constraint(equalToConstant: 400)
            chatTitle.font = .boldSystemFont(ofSize: NSFont.systemFontSize)
            chatTitle.lineBreakMode = .byTruncatingTail
            chatTitle.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            chatActions.onNewChat = { [weak self] in
                guard let project = self?.currentProject else { return }
                emit(["event":"shell-action", "action":"new-chat", "project":project])
            }
            for view in [chatTitle, chatActions] { view.translatesAutoresizingMaskIntoConstraints = false; chatHeader.addSubview(view) }
            NSLayoutConstraint.activate([
                chatHeaderWidth, chatHeader.widthAnchor.constraint(greaterThanOrEqualToConstant: 100), chatHeader.heightAnchor.constraint(equalToConstant: 32),
                chatTitle.leadingAnchor.constraint(equalTo: chatHeader.leadingAnchor, constant: 4), chatTitle.centerYAnchor.constraint(equalTo: chatHeader.centerYAnchor),
                chatTitle.trailingAnchor.constraint(lessThanOrEqualTo: chatActions.leadingAnchor, constant: -8),
                chatActions.trailingAnchor.constraint(equalTo: chatHeader.trailingAnchor, constant: -12),
                chatActions.centerYAnchor.constraint(equalTo: chatHeader.centerYAnchor),
                chatActions.widthAnchor.constraint(equalToConstant: 76), chatActions.heightAnchor.constraint(equalToConstant: 36)
            ])
            item.view = chatHeader; item.isBordered = false; item.visibilityPriority = .high
        } else if key == "address" {
            address.placeholderString = "Preview"; address.setAccessibilityLabel("Preview address")
            address.font = .boldSystemFont(ofSize: NSFont.systemFontSize); address.lineBreakMode = .byTruncatingMiddle
            address.isBordered = false; address.drawsBackground = false
            address.delegate = self; address.target = self; address.action = #selector(navigateAddress(_:))
            branchMenu.isBordered = false; branchMenu.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
            branchMenu.setAccessibilityLabel("Branch"); branchMenu.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            // The URL keeps its host and path ends; a branch name keeps its start.
            branchMenu.cell?.lineBreakMode = .byTruncatingTail
            let header = addressHeader
            for view in [address, branchMenu] { header.addArrangedSubview(view) }
            header.orientation = .vertical; header.alignment = .leading; header.spacing = 0
            header.translatesAutoresizingMaskIntoConstraints = false
            address.translatesAutoresizingMaskIntoConstraints = false; branchMenu.translatesAutoresizingMaskIntoConstraints = false
            let width = header.widthAnchor.constraint(equalToConstant: ToolbarAddressLayout.minimum); addressWidth = width
            NSLayoutConstraint.activate([header.widthAnchor.constraint(greaterThanOrEqualToConstant: ToolbarAddressLayout.floor), width,
                address.widthAnchor.constraint(equalTo: header.widthAnchor), branchMenu.widthAnchor.constraint(lessThanOrEqualTo: header.widthAnchor)])
            configureStatesMenu(in: header)
            item.view = header; item.isBordered = false
        } else if key == "publish" {
            item.image = nil
            item.isBordered = true; item.visibilityPriority = .high
        }
        item.autovalidates = false; toolbarItems[key] = item
        updateToolbar()
        return item
    }
    @objc func navigateAddress(_ sender: Any?) {
        let value = address.stringValue
        window?.makeFirstResponder(nil)
        emit(["event":"shell-action", "action":"address", "value":value])
        showAddress()
    }
    private var previewAddress: String { previewState["previewURL"] as? String ?? previewState["previewBase"] as? String ?? "" }
    private func showAddress() {
        address.stringValue = previewAddress
        address.toolTip = previewAddress
    }
    func controlTextDidBeginEditing(_ notification: Notification) {
        guard let editor = address.currentEditor() else { return }
        editor.string = previewAddress; editor.selectAll(nil)
    }
    func controlTextDidEndEditing(_ notification: Notification) {
        DispatchQueue.main.async { [weak self] in
            if self?.address.currentEditor() == nil { self?.showAddress() }
        }
    }
    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == #selector(NSResponder.cancelOperation(_:)) {
            showAddress()
            window?.makeFirstResponder(nil); return true
        }
        return false
    }
    @objc func sidebarAction(_ button: NSButton) {
        let action = button.identifier?.rawValue ?? ""
        if action == "new-chat" {
            guard let project = currentProject else { return }
            emit(["event":"shell-action", "action":action, "project":project])
        } else { emit(["event":"menu", "action":action]) }
    }
    @objc func toolbarAction(_ item: NSToolbarItem) {
        if item.itemIdentifier.rawValue == "overlay", let overlayAction { overlayAction(); return }
        emit(["event":"shell-action", "action":item.itemIdentifier.rawValue])
    }
    @objc func previewMenuAction(_ item: NSMenuItem) {
        guard let payload = item.representedObject as? [String: String] else { return }
        if payload["action"] == "new-branch" {
            guard let window = window else { return }
            let project = currentProject
            let alert = NSAlert(); alert.messageText = "New branch"; alert.informativeText = "Create a branch from the current one and switch to it."; alert.addButton(withTitle: "Create branch"); alert.addButton(withTitle: "Cancel")
            let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24)); input.placeholderString = "Branch name"; alert.accessoryView = input
            alert.beginSheetModal(for: window) { [weak self] result in
                guard result == .alertFirstButtonReturn, !input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, project == self?.currentProject else { return }
                emit(["event":"shell-action", "action":"new-branch", "value":input.stringValue])
            }
            alert.window.makeFirstResponder(input)
        } else { emit(payload) }
    }
    func updateToolbar() {
        defer { for group in toolbar.items.compactMap({ $0 as? MomentaryToolbarGroup }) { group.refresh() } }
        for (key, item) in toolbarItems {
            item.isEnabled = key == "chat" ? true : key == "branch" ? previewState["branch"] is String : ready
        }
        chatTitle.stringValue = allRows.first(where: { $0.id == selectedID })?.title ?? "Chat"
        chatTitle.toolTip = chatTitle.stringValue
        if chatHeaderWidth != nil {
            alignChatHeader()
        }
        chatTitle.isHidden = !chatReady || chatHidden || (chatHeaderWidth?.constant ?? 0) < 150
        // The header item stays in the toolbar (so the address never shifts); only its contents hide.
        chatActions.isHidden = !chatReady
        let chatMenu = NSMenu(); chatMenu.autoenablesItems = false
        for row in rows.first(where: { $0.project == currentProject })?.children ?? [] {
            let entry = NSMenuItem(title: row.title + (row.running ? " · Working" : ""), action: #selector(contextAction(_:)), keyEquivalent: "")
            entry.target = self; entry.representedObject = ["event":"shell-action", "action":"select", "id":row.id, "project":row.project]
            entry.state = row.id == selectedID ? .on : .off
            entry.image = NSImage(systemSymbolName: row.kind == "history" ? "clock" : "bubble.left", accessibilityDescription: nil)
            chatMenu.addItem(entry)
        }
        if let selectedID, currentProject != nil {
            chatMenu.addItem(.separator())
            let rename = NSMenuItem(title: "Rename current chat…", action: #selector(contextAction(_:)), keyEquivalent: "")
            rename.target = self; rename.representedObject = ["event":"shell-action", "action":"rename-chat", "id":selectedID]; chatMenu.addItem(rename)
            let close = NSMenuItem(title: "Close current chat", action: #selector(contextAction(_:)), keyEquivalent: "")
            close.target = self; close.representedObject = ["event":"shell-action", "action":"close", "id":selectedID]; chatMenu.addItem(close)
        }
        chatActions.historyMenu = chatMenu; chatActions.updateEnabled(project: chatReady, history: chatReady && !chatMenu.items.isEmpty)
        address.isEnabled = ready
        if address.currentEditor() == nil { showAddress() }
        toolbarItems["device"]?.isEnabled = previewState["deviceEnabled"] as? Bool ?? false
        toolbarItems["select-object"]?.label = selecting ? "Stop Selecting" : "Select Object"
        toolbarItems["select-object"]?.toolTip = toolbarItems["select-object"]?.label
        toolbarItems["select-object"]?.image = toolbarSymbol(selecting ? "cursorarrow.rays" : "cursorarrow", toolbarItems["select-object"]?.label)
        let mobile = previewState["viewport"] as? String == "mobile"
        toolbarItems["device"]?.label = mobile ? "Switch to Desktop" : "Switch to Mobile"
        toolbarItems["device"]?.toolTip = toolbarItems["device"]?.label
        toolbarItems["device"]?.image = toolbarSymbol(mobile ? "desktopcomputer" : "iphone", toolbarItems["device"]?.label)
        do {
            let title = previewState["branch"] as? String ?? "Branch"
            let status = previewState["branchStatus"] as? [String: Any] ?? [:]
            let sync = status["sync"] as? String ?? ""
            let ci = status["ci"] as? String ?? "unknown"
            let failing = status["failing"] as? [String] ?? []
            let step = previewState["publishStep"] as? String
            let pr = status["pr"] as? [String: Any]
            let prText = (pr?["number"] as? Int).map { "PR #\($0) \(pr?["state"] as? String ?? "open")" } ?? ""
            let ciText = ci == "failed" ? "●\(failing.count)" : ci == "running" ? "◌" : ci == "passed" ? "●" : ci == "none" ? "○" : "?"
            let ahead = status["ahead"] as? Int ?? 0, behind = status["behind"] as? Int ?? 0
            let compactSync = ahead == 0 && behind == 0 ? "✓" : [ahead > 0 ? "\(ahead)↑" : "", behind > 0 ? "\(behind)↓" : ""].filter { !$0.isEmpty }.joined(separator: " ")
            // The check state comes first so AppKit's tail truncation cannot hide it.
            let compactPR = (pr?["number"] as? Int).map { "#\($0)" } ?? ""
            let detail = step.map { "↗ \($0)" } ?? "\(ciText) · \(compactSync)\(compactPR.isEmpty ? "" : " · " + compactPR)"
            let display = "\(title) · \(detail)"
            branchMenu.toolTip = [title, sync, prText, ci == "unknown" ? "CI unknown" : "CI \(ci): \(failing.joined(separator: ", "))"].filter { !$0.isEmpty }.joined(separator: "\n")
            branchMenu.isEnabled = previewState["branch"] is String
            let menu = NSMenu(); menu.autoenablesItems = false
            func add(_ title: String, _ action: String, _ value: String = "") {
                let entry = NSMenuItem(title: title, action: #selector(previewMenuAction(_:)), keyEquivalent: ""); entry.target = self
                entry.representedObject = ["event":"shell-action", "action":action, "value":value]
                if action == "branch" { entry.state = value == previewState["branch"] as? String ? .on : .off }
                menu.addItem(entry)
            }
            if !sync.isEmpty { let row = NSMenuItem(title: sync, action: nil, keyEquivalent: ""); row.isEnabled = false; menu.addItem(row) }
            if let pr = status["pr"] as? [String: Any], let number = pr["number"] as? Int {
                add("PR #\(number) \(pr["state"] as? String ?? "open") · View on GitHub", "branch-open-url", pr["url"] as? String ?? "")
            }
            if ci != "unknown" { add("CI \(ci)\(failing.isEmpty ? "" : ": " + failing.joined(separator: ", ")) · View checks", "branch-open-url", status["checksUrl"] as? String ?? "") }
            add("Git Updates…", "git-updates"); menu.addItem(.separator())
            for branch in previewState["branches"] as? [String] ?? [] { add(branch, "branch", branch) }
            menu.addItem(.separator()); add("New Branch…", "new-branch")
            menu.insertItem(withTitle: display, action: nil, keyEquivalent: "", at: 0)
            menu.items.first?.attributedTitle = branchTitle(display)
            branchMenu.menu = menu
            animateBranch(display, active: step != nil || ci == "running")
        }
        if let item = toolbarItems["publish"] as? NSMenuToolbarItem { updatePublish(item, state: previewState, ready: ready) }
        toolbarItems["code"]?.toolTip = previewState["codeOpen"] as? Bool == true ? "Hide Code" : "Show Code"
        toolbarItems["code"]?.label = toolbarItems["code"]?.toolTip ?? "Show Code"
        toolbarItems["expand"]?.toolTip = chatHidden ? "Restore Layout" : "Expand Preview"
        toolbarItems["expand"]?.label = toolbarItems["expand"]?.toolTip ?? "Expand Preview"
        toolbarItems["expand"]?.image = toolbarSymbol(chatHidden ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right", chatHidden ? "Restore Layout" : "Expand Preview")
    }
    func update(_ state: [String: Any]) {
        applying = true; defer { applying = false }
        // Reloading rebuilds the row objects, which drops the outline's selection.
        let highlighted = (outline.item(atRow: outline.selectedRow) as? ShellRow)?.id
        let rowData = state["rows"] as? [[String: Any]] ?? []
        let signature = (try? JSONSerialization.data(withJSONObject: rowData, options: [.sortedKeys])) ?? Data()
        let rowsChanged = signature != rowsSignature
        if rowsChanged { rowsSignature = signature; rows = rowData.map(ShellRow.init) }
        let nextProject = state["project"] as? String
        if nextProject != currentProject && address.currentEditor() != nil { window?.makeFirstResponder(nil) }
        let projectChanged = nextProject != currentProject
        currentProject = nextProject
        chatReady = nextProject != nil && state["chatReady"] as? Bool == true
        selectedID = state["selected"] as? String
        ready = state["previewReady"] as? Bool ?? false
        selecting = state["selectMode"] as? Bool ?? false
        let expandedPreview = state["chatHidden"] as? Bool ?? false
        if expandedPreview != chatHidden {
            if expandedPreview { sidebarBeforeExpand = sidebarItem.isCollapsed }
            NSAnimationContext.runAnimationGroup { context in
                context.duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0 : 0.24
                context.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0, 0, 1)
                sidebarItem.animator().isCollapsed = expandedPreview || sidebarBeforeExpand
            }
        }
        chatHidden = expandedPreview
        previewState = state
        let chatIndex = toolbar.items.firstIndex { $0.itemIdentifier.rawValue == "chat" }
        let showChat = currentProject != nil && !chatHidden && (state["chatWidth"] as? Double ?? 0) > 60
        if !showChat, let index = chatIndex { toolbar.removeItem(at: index) }
        else if showChat && chatIndex == nil {
            let index = toolbar.items.firstIndex { $0.itemIdentifier.rawValue == "address" } ?? 0
            toolbar.insertItem(withItemIdentifier: NSToolbarItem.Identifier("chat"), at: index)
        }

        if rowsChanged || projectChanged { outline.reloadData() }
        // A state older than the latest pick keeps the picked row highlighted (LKM-204).
        if selection.answers(state) {
            if let selected = rows.first(where: { $0.project == currentProject }) {
                let index = outline.row(forItem: selected)
                if index >= 0 && outline.selectedRow != index { outline.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false) }
            } else if outline.selectedRow >= 0 { outline.deselectAll(nil) }
        } else if let highlighted, let picked = allRows.first(where: { $0.id == highlighted }) {
            let index = outline.row(forItem: picked)
            if index >= 0 && outline.selectedRow != index { outline.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false) }
        }
        noteSelection()
        window?.subtitle = ""
        updateToolbar()
    }
    var allRows: [ShellRow] { rows.flatMap { [$0] + $0.children } }
    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int { item == nil ? rows.count : 0 }
    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any { rows[index] }
    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool { false }
    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        let row = item as! ShellRow
        let cell = ProjectCell(); cell.selected = row.project == currentProject
        let symbol = row.kind == "project" ? "folder" : row.kind == "history" ? "clock" : "bubble.left"
        // Project rows share Open Project's symbol, regardless of stored artwork.
        let artwork = (row.kind == "project" ? nil : row.icon)
            ?? NSImage(systemSymbolName: symbol, accessibilityDescription: nil)!
        let more = cell.more
        more.bezelStyle = .inline; more.setAccessibilityLabel("Actions for " + row.title)
        (more.cell as? NSPopUpButtonCell)?.arrowPosition = .noArrow
        let menu = projectMenu(row)
        let trigger = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        trigger.image = NSImage(systemSymbolName: "ellipsis", accessibilityDescription: "Project actions")
        menu.insertItem(trigger, at: 0); more.menu = menu
        more.translatesAutoresizingMaskIntoConstraints = false; cell.addSubview(more)
        let text = cell.install(title: row.title + (row.running ? " · Working" : ""), image: artwork)
        NSLayoutConstraint.activate([
            text.trailingAnchor.constraint(equalTo: more.leadingAnchor, constant: -4),
            more.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -4), more.centerYAnchor.constraint(equalTo: cell.centerYAnchor), more.widthAnchor.constraint(equalToConstant: 28)
        ])
        cell.toolTip = row.title
        return cell
    }
    func outlineViewSelectionDidChange(_ notification: Notification) {
        guard !applying, let row = outline.item(atRow: outline.selectedRow) as? ShellRow else { return }
        emit(["event":"shell-action", "action":"select", "id":row.id, "generation":selection.pick()])
        noteSelection()
    }
    func noteSelection() { selection.note(sidebar: (outline.item(atRow: outline.selectedRow) as? ShellRow)?.project, window: currentProject) }
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        guard let row = outline.item(atRow: outline.clickedRow) as? ShellRow else { return }
        for item in projectMenu(row).items { menu.addItem(item.copy() as! NSMenuItem) }
    }
    func projectMenu(_ row: ShellRow) -> NSMenu {
        let menu = NSMenu(); menu.autoenablesItems = false
        for (title, action) in [("Project Memory…", "memory"), ("Close Project", "close")] {
            let item = NSMenuItem(title: title, action: #selector(contextAction(_:)), keyEquivalent: "")
            item.target = self; item.representedObject = ["event":"shell-action", "action":action, "id":row.id, "project":row.project]; menu.addItem(item)
        }
        return menu
    }
    @objc func contextAction(_ item: NSMenuItem) { if let payload = item.representedObject as? [String: String] { emit(payload) } }

    // Private pipe-only integration checks exercise actual native controls.
    func inspect() -> [String: Any] {
        split.view.layoutSubtreeIfNeeded()
        let sidebarFrame = sidebar.view.convert(sidebar.view.bounds, to: nil)
        let trafficLight = window?.standardWindowButton(.closeButton)
        let trafficFrame = trafficLight.map { $0.convert($0.bounds, to: nil) } ?? .zero
        let branchInspect: [String: Any] = ["branchDisplay":branchMenu.menu?.items.first?.title ?? "",
                                            "branchStatus":previewState["branchStatus"] ?? [:],
                                            "publishStep":previewState["publishStep"] ?? ""]
        return ["sidebarContainsTrafficLights":sidebarFrame.contains(trafficFrame),
         "interactionGroup":(toolbar.items.first(where: { $0.itemIdentifier.rawValue == "interaction" }) as? NSToolbarItemGroup)?.subitems.map { $0.itemIdentifier.rawValue } ?? [], "selectMode":selecting, "projectsMenuOnly":toolbarItems["projects"]?.action == nil,
         "sidebarTop":sidebarFrame.maxY, "contentTop":window?.contentLayoutRect.maxY ?? 0,
         "detailTop":contentCanvas.convert(contentCanvas.bounds, to: nil).maxY,
         "sidebarListTop":outline.enclosingScrollView.map { $0.convert($0.bounds, to: nil).maxY } ?? 0,
         "rows":allRows.map { ["id":$0.id, "title":$0.title, "kind":$0.kind] }, "selected":selectedID ?? "", "sidebarCollapsed":sidebarItem.isCollapsed, "sourceList":SourceList.inspect(outline, item: sidebarItem),
         "sidebarWidth":sidebar.view.bounds.width, "detailWidth":split.splitViewItems[1].viewController.view.bounds.width,
         "projectMoreRightEdges":(0..<outline.numberOfRows).compactMap { index -> CGFloat? in
             guard let cell = outline.view(atColumn: 0, row: index, makeIfNecessary: true) as? ProjectCell, let clip = outline.enclosingScrollView?.contentView else { return nil }
             cell.layoutSubtreeIfNeeded()
             return cell.more.convert(cell.more.bounds, to: clip).maxX
         }, "projectIconCount":rows.filter { $0.icon != nil }.count, "outlineClipWidth":outline.enclosingScrollView?.contentSize.width ?? 0, "outlineRows":outline.numberOfRows, "outlineWidth":outline.bounds.width,
         "toolbar":toolbar.items.map { $0.itemIdentifier.rawValue }, "branch":previewState["branch"] ?? "", "publishLabel":previewState["publishLabel"] ?? "", "codeOpen":previewState["codeOpen"] ?? false,
         "toolbarGroupsMomentary":toolbar.items.compactMap { $0 as? NSToolbarItemGroup }.allSatisfy { ($0 as? MomentaryToolbarGroup)?.hasMomentaryControl == true }, "visibleToolbar":toolbar.visibleItems?.map { $0.itemIdentifier.rawValue } ?? [], "previewHeaderLightText":previewTextColor == .white, "address":previewAddress, "domain":address.stringValue, "viewport":previewState["viewport"] ?? "", "publishStandard":toolbarItems["publish"]?.view == nil, "toolGroup":(toolbar.items.first(where: { $0.itemIdentifier.rawValue == "tools" }) as? NSToolbarItemGroup)?.subitems.map { $0.itemIdentifier.rawValue } ?? [], "sidebarAutohidesScrollers":(outline.enclosingScrollView?.autohidesScrollers ?? false), "sidebarActions":sidebarButtons.keys.sorted(), "chatActions":["history", "new-chat"], "historyIDs":chatActions.historyMenu?.items.compactMap { ($0.representedObject as? [String:String])?["id"] } ?? [], "chatTitle":chatTitle.stringValue, "chatTitlePlain":toolbarItems["chat"]?.action == nil, "chatHeaderWidth":chatHeader.bounds.width, "chatHeaderTrailing":chatHeader.convert(NSPoint(x: chatHeader.bounds.maxX, y: 0), to: nil).x, "detailLeading":split.splitViewItems[1].viewController.view.convert(.zero, to: nil).x, "chatWidth":previewState["chatWidth"] ?? 0, "enabled":toolbarItems.mapValues { $0.isEnabled }]
            .merging(branchInspect) { _, new in new }
            .merging(toolbarInspect()) { _, new in new }.merging(["resizeSnapshot":resizeSnapshot]) { _, new in new }
            .merging(publishInspect(toolbarItems["publish"] as? NSMenuToolbarItem, state: previewState)) { _, new in new }
            .merging(moreInspect(toolbarItems["more"] as? NSMenuToolbarItem)) { _, new in new }
    }
    func perform(_ action: String, id: String?) -> Bool {
        if action == "window-width", let width = Double(id ?? ""), let window, width >= 850 && width <= 2000 {
            var frame = window.frame; frame.size.width = width; window.setFrame(frame, display: true)
            // Read before returning to the run loop: no deferred alignment has run yet.
            resizeSnapshot = toolbarInspect(); return true
        }
        // Test captures force the window's own appearance (nil: follow the system); system settings are never touched.
        if action == "window-appearance" { window?.appearance = id == "dark" ? NSAppearance(named: .darkAqua) : id == "light" ? NSAppearance(named: .aqua) : nil; return true }
        if action == "sidebar-width", let id, let width = Double(id), (180...340).contains(width) {
            setSidebarContentWidth(width, in: split); return true
        }
        if action == "toggle-sidebar" {
            // No animation in the pipe test: an occluded/locked desktop can pause
            // AppKit animations even though the collapsed state already changed.
            sidebarItem.isCollapsed.toggle(); split.view.layoutSubtreeIfNeeded(); return true
        }
        if action == "new-chat", chatReady { chatActions.onNewChat?(); return true }
        if action == "history-select", let entry = chatActions.historyMenu?.items.first(where: { ($0.representedObject as? [String:String])?["id"] == id }) {
            contextAction(entry); return true
        }
        if action == "selection-trail-reset" { selection.reset(); noteSelection(); return true }
        if action == "select-row", let row = rows.first(where: { $0.id == id }) {
            let index = outline.row(forItem: row)
            guard index >= 0 else { return false }
            outline.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false); return true
        }
        if ["new-project", "open-project"].contains(action), let menu = (toolbarItems["projects"] as? NSMenuToolbarItem)?.menu,
           let entry = menu.items.first(where: { ($0.representedObject as? [String: String])?["action"] == action }) { contextAction(entry); return true }
        if action == "address", let value = id { address.stringValue = value; navigateAddress(nil); return true }
        if ["branch", "publish-mode"].contains(action), let value = id,
           let menu = action == "branch" ? branchMenu.menu : (toolbarItems["publish"] as? NSMenuToolbarItem)?.menu,
           let entry = menu.items.first(where: { ($0.representedObject as? [String: String])?["value"] == value && ($0.representedObject as? [String: String])?["action"] == action }), entry.isEnabled {
            previewMenuAction(entry); return true
        }
        if action == "publish-cancel" { return cancelPublish(toolbarItems["publish"] as? NSMenuToolbarItem) }
        if action == "preview-more", let id { return performMore(toolbarItems["more"] as? NSMenuToolbarItem, id) }
        if action == "states-menu", let id { return performStatesMenu(id) }
        if action == "preview-speed", let id { return performSpeed(id) }
        if action == "publish", toolbarItems["publish"]?.action == nil { return false }
        if let button = sidebarButtons[action], button.isEnabled { sidebarAction(button); return true }
        if let group = toolbar.items.compactMap({ $0 as? MomentaryToolbarGroup }).first(where: { $0.subitems.contains { $0.itemIdentifier.rawValue == action } }) { return group.clickSegment(action) }
        guard let item = toolbarItems[action], item.isEnabled else { return false }
        toolbarAction(item); return true
    }
}
