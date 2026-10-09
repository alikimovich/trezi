import AppKit

/// LKM-206: the preview's slow-motion menu. LKM-213: the last segment of the interaction group
/// (select | device | ruler | slow motion), whose click opens this menu (`MomentaryToolbarGroup`);
/// like "…", the segment leaves windows under 1000 pt (`fitMore`), and the View menu keeps it.
/// Its entries go to Bun as `speed` shell actions (`src/native/preview-speed.ts`), which owns the
/// session's speed; the glyph turns filled and accent-coloured while the preview is slowed or
/// paused (`Host.setPreviewSpeed`).
extension NativeShell {
    static let speedEntries: [(String, String)] = [("Normal Speed (1×)", "1"), ("0.5×", "0.5"), ("0.25×", "0.25"), ("0.1×", "0.1"), ("Paused", "0")]
    func configureSpeed(_ item: NSMenuToolbarItem) {
        item.showsIndicator = false
        updateSpeed(1)
    }
    func updateSpeed(_ speed: Double) {
        guard let item = toolbarItems["speed"] as? NSMenuToolbarItem else { return }
        let slowed = speed != 1
        item.label = slowed ? "Slow Motion \(previewSpeedLabel(speed))" : "Slow Motion"
        item.paletteLabel = "Slow Motion"; item.toolTip = item.label
        item.image = slowed ? toolbarAccentSymbol("tortoise.fill", item.label) : toolbarSymbol("tortoise", item.label)
        defer { for group in toolbar.items.compactMap({ $0 as? MomentaryToolbarGroup }) { group.refresh() } }
        let menu = NSMenu(); menu.autoenablesItems = false
        for (title, value) in Self.speedEntries {
            let entry = NSMenuItem(title: title, action: #selector(previewMenuAction(_:)), keyEquivalent: ""); entry.target = self
            entry.representedObject = ["event":"shell-action", "action":"speed", "value":value]
            entry.state = Double(value) == speed ? .on : .off
            menu.addItem(entry)
        }
        menu.addItem(.separator())
        let step = NSMenuItem(title: "Step Frame", action: #selector(previewMenuAction(_:)), keyEquivalent: ""); step.target = self
        step.representedObject = ["event":"shell-action", "action":"speed", "value":"step"]
        menu.addItem(step)
        item.menu = menu
    }
    /// Pipe checks pick an entry the way a click on it would.
    func performSpeed(_ value: String) -> Bool {
        guard let item = toolbarItems["speed"] as? NSMenuToolbarItem, item.isEnabled,
              let entry = item.menu.items.first(where: { ($0.representedObject as? [String: String])?["value"] == value }) else { return false }
        previewMenuAction(entry); return true
    }
    func speedInspect() -> [String: Any] {
        let item = toolbarItems["speed"] as? NSMenuToolbarItem
        // Prominent: the segment draws the accent glyph rather than the plain template.
        let prominent = item?.image.map { !$0.isTemplate } ?? false
        return ["speedMenu":item?.menu.items.map(\.title) ?? [], "speedChecked":item?.menu.items.first { $0.state == .on }?.title ?? "",
                "speedLabel":item?.label ?? "", "speedProminent":prominent, "speedEnabled":item?.isEnabled ?? false]
    }
}
