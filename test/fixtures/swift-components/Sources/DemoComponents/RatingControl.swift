import AppKit

/// An AppKit star rating: click a star or use the arrow keys.
public final class RatingControl: NSView {
    public var rating = 0 { didSet { needsDisplay = true; onChange?(rating) } }
    public var maximum = 5
    public var onChange: ((Int) -> Void)?
    public var starColor = NSColor.systemOrange

    private let starSize: CGFloat = 32
    private let spacing: CGFloat = 8

    public override var intrinsicContentSize: NSSize {
        NSSize(width: CGFloat(maximum) * (starSize + spacing) - spacing, height: starSize + 28)
    }

    public override var acceptsFirstResponder: Bool { true }
    public override var isFlipped: Bool { true }

    public override func draw(_ dirtyRect: NSRect) {
        let symbols = (filled: NSImage(systemSymbolName: "star.fill", accessibilityDescription: nil),
                       empty: NSImage(systemSymbolName: "star", accessibilityDescription: nil))
        for index in 0..<maximum {
            let rect = NSRect(x: CGFloat(index) * (starSize + spacing), y: 0, width: starSize, height: starSize)
            let image = index < rating ? symbols.filled : symbols.empty
            let tinted = image?.withSymbolConfiguration(.init(pointSize: starSize * 0.8, weight: .regular)
                .applying(.init(paletteColors: [index < rating ? starColor : .tertiaryLabelColor])))
            tinted?.draw(in: rect)
        }
        let label = "Rating: \(rating) of \(maximum)" as NSString
        label.draw(at: NSPoint(x: 0, y: starSize + 8),
                   withAttributes: [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: NSColor.secondaryLabelColor])
    }

    public override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        let point = convert(event.locationInWindow, from: nil)
        let index = Int(point.x / (starSize + spacing))
        if point.y <= starSize, (0..<maximum).contains(index) { rating = index + 1 }
    }

    public override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 123, 125: rating = max(0, rating - 1)
        case 124, 126: rating = min(maximum, rating + 1)
        default: super.keyDown(with: event)
        }
    }

    public override func isAccessibilityElement() -> Bool { true }
    public override func accessibilityRole() -> NSAccessibility.Role? { .slider }
    public override func accessibilityLabel() -> String? { "Rating" }
    public override func accessibilityValue() -> Any? { "\(rating) of \(maximum) stars" }
}
