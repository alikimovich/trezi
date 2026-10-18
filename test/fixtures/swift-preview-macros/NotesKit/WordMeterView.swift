import AppKit

// An AppKit view: a `#Preview` that builds and returns an `NSView`.

public final class WordMeterView: NSView {
    public var words: Int {
        didSet { needsDisplay = true }
    }

    public init(words: Int = 120) {
        self.words = words
        super.init(frame: NSRect(x: 0, y: 0, width: 220, height: 40))
    }

    required init?(coder: NSCoder) {
        fatalError("WordMeterView is not loaded from a nib")
    }

    override public var intrinsicContentSize: NSSize { NSSize(width: 220, height: 40) }

    override public func draw(_ dirtyRect: NSRect) {
        NSColor.controlBackgroundColor.setFill()
        bounds.fill()
        let filled = bounds.width * CGFloat(min(words, 500)) / 500
        NSColor.controlAccentColor.setFill()
        NSRect(x: 0, y: 0, width: filled, height: bounds.height).fill()
        let label = "\(words) words" as NSString
        label.draw(at: NSPoint(x: 8, y: 12), withAttributes: [.font: NSFont.systemFont(ofSize: 13)])
    }
}

#Preview("Word meter", traits: .fixedLayout(width: 240, height: 60)) {
    let meter = WordMeterView()
    meter.words = 340
    return meter
}
