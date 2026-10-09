import AppKit

/// Divider positions include AppKit's sidebar wrapper; captures measure its content.
func setSidebarContentWidth(_ width: CGFloat, in split: NSSplitViewController) {
    split.view.layoutSubtreeIfNeeded()
    guard let item = split.splitViewItems.first,
          let wrapper = split.splitView.arrangedSubviews.first else { return }
    let inset = wrapper.frame.width - item.viewController.view.bounds.width
    split.splitView.setPosition(width + inset, ofDividerAt: 0)
    split.view.layoutSubtreeIfNeeded()
}
