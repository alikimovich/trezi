import AppKit
import SwiftUI

/// The search panel's dependency: what a query finds.
public protocol SearchIndex {
    func search(_ query: String) -> [String]
}

/// A SwiftUI badge embedded in the AppKit panel below.
struct ResultBadge: View {
    let count: Int
    var body: some View {
        Text(count == 1 ? "1 match" : "\(count) matches")
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(count > 0 ? Color.green.opacity(0.25) : Color.gray.opacity(0.2)))
    }
}

/// An AppKit view controller (text field, button, label) that hosts a SwiftUI badge:
/// the mixed AppKit/SwiftUI shape of apps like Trezi.
public final class SearchPanelController: NSViewController {
    private let index: SearchIndex
    private let field = NSTextField()
    private let button = NSButton(title: "Search", target: nil, action: nil)
    private let results = NSTextField(labelWithString: "Type a query and press Search")
    private let badge = NSHostingView(rootView: ResultBadge(count: 0))

    public init(index: SearchIndex) {
        self.index = index
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    public override func loadView() {
        let title = NSTextField(labelWithString: "Search components")
        title.font = .boldSystemFont(ofSize: 15)
        field.placeholderString = "Query"
        field.target = self
        field.action = #selector(search)
        button.target = self
        button.action = #selector(search)
        button.bezelStyle = .rounded
        badge.sizingOptions = [.intrinsicContentSize]
        let row = NSStackView(views: [field, button])
        let stack = NSStackView(views: [title, row, results, badge])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 18, left: 18, bottom: 18, right: 18)
        field.widthAnchor.constraint(equalToConstant: 200).isActive = true
        view = stack
    }

    @objc private func search() {
        let query = field.stringValue.trimmingCharacters(in: .whitespaces)
        let found = index.search(query)
        results.stringValue = query.isEmpty ? "Type a query and press Search" : "Results for \(query): \(found.joined(separator: ", "))"
        badge.rootView = ResultBadge(count: found.count)
    }
}
