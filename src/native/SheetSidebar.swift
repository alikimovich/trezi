import AppKit
import Combine
import SwiftUI

/// A sectioned window (Settings), like Xcode's: a full-size-content window whose split
/// view starts with a full-height, translucent source-list sidebar under the traffic
/// lights, then the selected section's pane (`SectionedSheetContent`). The window
/// title follows the selected section; arrow keys in the outline change it.
final class SheetSplit: NSSplitViewController, NSOutlineViewDataSource, NSOutlineViewDelegate, NSToolbarDelegate {
    static let sidebarWidth: CGFloat = 200
    static let sidebarRange: ClosedRange<CGFloat> = 180...260
    let model: SheetModel
    let outline = NSOutlineView()
    private(set) var sidebarItem: NSSplitViewItem!
    private var sections: [SheetSection] = []
    /// Stable outline items (the section ids); the outline tracks rows by item identity.
    private var items: [NSString] = []
    private var syncing = false
    private var observers: Set<AnyCancellable> = []

    init(model: SheetModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        SourceList.configure(outline, label: "Settings sections")
        outline.allowsEmptySelection = false
        outline.dataSource = self; outline.delegate = self
        let sidebar = NSViewController(); sidebar.view = NSView()
        let scroll = SourceList.scrollView(outline)
        scroll.translatesAutoresizingMaskIntoConstraints = false
        sidebar.view.addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: sidebar.view.safeAreaLayoutGuide.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: sidebar.view.leadingAnchor), scroll.trailingAnchor.constraint(equalTo: sidebar.view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: sidebar.view.bottomAnchor)
        ])
        sidebarItem = SourceList.sidebarItem(sidebar, minimum: Self.sidebarRange.lowerBound, maximum: Self.sidebarRange.upperBound)
        sidebarItem.canCollapse = false
        addSplitViewItem(sidebarItem)
        // The window sets its own minimum; the pane must not push SwiftUI sizes into the split.
        let pane = NSHostingController(rootView: SheetContent(model: model))
        pane.sizingOptions = []
        let detail = NSSplitViewItem(viewController: pane)
        detail.minimumThickness = SectionedSheetContent.minimumSize.width - Self.sidebarRange.upperBound
        addSplitViewItem(detail)
        model.$section.combineLatest(model.$state).sink { [weak self] in self?.sync(section: $0, state: $1) }.store(in: &observers)
    }

    /// Full-size content, a unified toolbar that places the title over the pane, the
    /// sidebar width, and keyboard focus in the outline.
    func attach(to window: NSWindow) {
        window.styleMask.insert(.fullSizeContentView)
        window.titlebarAppearsTransparent = false
        window.titleVisibility = .visible
        let toolbar = NSToolbar(identifier: "TreziSettingsToolbar")
        toolbar.delegate = self; toolbar.displayMode = .iconOnly
        toolbar.allowsUserCustomization = false; toolbar.autosavesConfiguration = false
        window.toolbar = toolbar; window.toolbarStyle = .unified
        splitView.setPosition(Self.sidebarWidth, ofDividerAt: 0)
        window.initialFirstResponder = outline
        window.makeFirstResponder(outline)
        sync(section: model.section, state: model.state)
    }
    func detach() { observers.removeAll() }

    private func sync(section: String?, state: SheetState?) {
        guard isViewLoaded else { return }
        let next = state?.sections ?? []
        syncing = true; defer { syncing = false }
        if next.map(\.id) != sections.map(\.id) || next.map(\.label) != sections.map(\.label) || next.map(\.symbol) != sections.map(\.symbol) {
            sections = next; items = next.map { $0.id as NSString }
            outline.reloadData()
        }
        let index = sections.firstIndex { $0.id == section } ?? (sections.isEmpty ? -1 : 0)
        if index >= 0, outline.selectedRow != index { outline.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false) }
        if index >= 0 { view.window?.title = sections[index].label }
    }

    // Escape cancels like the form's own exit command; Bun owns dismissal.
    override func cancelOperation(_ sender: Any?) { model.perform("cancel") }

    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int { item == nil ? sections.count : 0 }
    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any { items[index] }
    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool { false }
    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        guard let section = sections.first(where: { $0.id == (item as? NSString) as String? }) else { return nil }
        let cell = SourceListCell()
        let image = NSImage(systemSymbolName: section.symbol, accessibilityDescription: nil) ?? NSImage(systemSymbolName: "gearshape", accessibilityDescription: nil)!
        let text = cell.install(title: section.label, image: image)
        text.trailingAnchor.constraint(lessThanOrEqualTo: cell.trailingAnchor, constant: -8).isActive = true
        cell.setAccessibilityLabel(section.label)
        return cell
    }
    func outlineViewSelectionDidChange(_ notification: Notification) {
        guard !syncing, outline.selectedRow >= 0, outline.selectedRow < sections.count else { return }
        model.select(sections[outline.selectedRow].id)
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { [.sidebarTrackingSeparator] }
    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { [.sidebarTrackingSeparator] }
    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? { nil }
}
