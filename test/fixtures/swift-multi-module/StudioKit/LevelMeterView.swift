import AppKit

/// A public AppKit component of the library module: segmented bars and a label.
public final class LevelMeterView: NSView {
    public var level: Int = 0 {
        didSet {
            label.stringValue = StudioFormat.level(level, of: segments)
            needsDisplay = true
        }
    }

    public let segments: Int
    private let label = NSTextField(labelWithString: "")

    public init(segments: Int = 5) {
        self.segments = segments
        super.init(frame: NSRect(x: 0, y: 0, width: 240, height: 72))
        label.stringValue = StudioFormat.level(0, of: segments)
        label.frame = NSRect(x: 12, y: 8, width: 216, height: 18)
        addSubview(label)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    public override var isFlipped: Bool { false }

    public override func draw(_ dirtyRect: NSRect) {
        let width = (bounds.width - 24 - CGFloat(segments - 1) * 6) / CGFloat(segments)
        for index in 0..<segments {
            let rect = NSRect(x: 12 + CGFloat(index) * (width + 6), y: 34, width: width, height: 26)
            (index < level ? NSColor.systemGreen : NSColor.quaternaryLabelColor).setFill()
            NSBezierPath(roundedRect: rect, xRadius: 4, yRadius: 4).fill()
        }
    }
}
