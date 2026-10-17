import AppKit
import Darwin
import SwiftUI

// The native component preview host (LKM-271). `driver.ts` compiles this file with a
// project's declared component sources and its preview declarations into one
// executable, then talks to it over stdin/stdout in JSON lines. It is never part of
// Trezi.app nor of the project's own targets. Each preview mounts in its own borderless
// window far off every screen; frames are drawn with `cacheDisplay` (no screen capture,
// so no privacy prompt) and input is posted to this process's own event queue (no
// Accessibility grant). The app is an accessory: no Dock icon and it never activates.

// MARK: Declarations (the API a project's preview file uses)

/// One explicitly declared component preview with its sample state and dependencies.
public struct TreziPreview {
    public enum Content { case view(NSView), controller(NSViewController) }
    public let id: String
    public let title: String
    public let kind: String
    public let size: CGSize?
    let make: @MainActor () -> Content

    public static func swiftUI<V: View>(_ id: String, _ title: String, size: CGSize? = nil,
                                        @ViewBuilder _ body: @escaping @MainActor () -> V) -> TreziPreview {
        TreziPreview(id: id, title: title, kind: "SwiftUI", size: size) {
            let hosting = NSHostingView(rootView: body())
            hosting.sizingOptions = []
            return .view(hosting)
        }
    }

    public static func appKit(_ id: String, _ title: String, size: CGSize? = nil,
                              _ make: @escaping @MainActor () -> NSView) -> TreziPreview {
        TreziPreview(id: id, title: title, kind: "AppKit", size: size) { .view(make()) }
    }

    public static func viewController(_ id: String, _ title: String, size: CGSize? = nil,
                                      _ make: @escaping @MainActor () -> NSViewController) -> TreziPreview {
        TreziPreview(id: id, title: title, kind: "AppKit view controller", size: size) { .controller(make()) }
    }
}

// MARK: Host

/// AppKit resolves no window for one that is off every screen (and without a window
/// server session every window number is 0), and it sends keys to its own key window.
/// Synthetic events therefore carry the addressed preview's input tag as their window
/// number, and are delivered to that preview's window here.
final class PreviewHostApplication: NSApplication {
    static let routed: Set<NSEvent.EventType> = [.leftMouseDown, .leftMouseUp, .leftMouseDragged, .rightMouseDown,
                                                 .rightMouseUp, .keyDown, .keyUp]

    override func sendEvent(_ event: NSEvent) {
        if Self.routed.contains(event.type) {
            if let window = PreviewWindow.tagged(event.windowNumber), !Self.firstMouse(event, window) { window.sendEvent(event) }
            return
        }
        super.sendEvent(event)
    }

    /// This app is never active, so AppKit would swallow a click on a view that does not
    /// accept the first mouse; deliver it straight to that view instead (as a click in
    /// an active window would be).
    private static func firstMouse(_ event: NSEvent, _ window: NSWindow) -> Bool {
        guard event.type == .leftMouseDown || event.type == .rightMouseDown,
              let view = window.contentView?.hitTest(event.locationInWindow), !view.acceptsFirstMouse(for: event) else { return false }
        if view.acceptsFirstResponder { window.makeFirstResponder(view) }
        if event.type == .leftMouseDown { view.mouseDown(with: event) } else { view.rightMouseDown(with: event) }
        return true
    }
}

/// Every preview window behaves as the key window of an active app, so the first click
/// reaches AppKit controls (no "first mouse" swallow) and focus rings and carets draw,
/// without ever activating this process or taking focus from the user's app.
final class PreviewWindow: NSWindow {
    static let tagBase = 0x5EE0_0000
    var inputTag = 0
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
    override var isKeyWindow: Bool { true }
    override var isMainWindow: Bool { true }

    @MainActor static func tagged(_ tag: Int) -> PreviewWindow? {
        NSApp.windows.lazy.compactMap { $0 as? PreviewWindow }.first { $0.inputTag == tag }
    }
}

/// The window background behind the component, so a frame looks like it does in a window.
final class PreviewSurface: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill()
        dirtyRect.fill()
    }
}

/// What the input thread needs without touching the main thread (which may be inside
/// a control's tracking loop waiting for the very mouse-up being posted).
struct MountedGeometry { let tag: Int; let height: CGFloat; let width: CGFloat }

@MainActor
final class MountedPreview {
    static let maxSize = CGSize(width: 1600, height: 1200)
    let preview: TreziPreview
    let window: PreviewWindow
    let surface: PreviewSurface
    let container = NSViewController()

    init(_ preview: TreziPreview, index: Int) {
        self.preview = preview
        let content = preview.make()
        let view: NSView
        var child: NSViewController?
        switch content {
        case .view(let made): view = made
        case .controller(let controller): child = controller; view = controller.view
        }
        let size = Self.size(preview.size, view)
        window = PreviewWindow(contentRect: NSRect(x: -40_000 - CGFloat(index) * 2_000, y: -40_000, width: size.width, height: size.height),
                               styleMask: [.borderless], backing: .buffered, defer: false)
        window.inputTag = PreviewWindow.tagBase + index
        window.isReleasedWhenClosed = false
        window.hasShadow = false
        window.isExcludedFromWindowsMenu = true
        window.collectionBehavior = [.transient, .ignoresCycle]
        surface = PreviewSurface(frame: NSRect(origin: .zero, size: size))
        container.view = surface
        window.contentViewController = container
        window.setContentSize(size)
        if let child { container.addChild(child) }
        view.translatesAutoresizingMaskIntoConstraints = false
        surface.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: surface.leadingAnchor), view.trailingAnchor.constraint(equalTo: surface.trailingAnchor),
            view.topAnchor.constraint(equalTo: surface.topAnchor), view.bottomAnchor.constraint(equalTo: surface.bottomAnchor)
        ])
        window.orderFrontRegardless()
        window.makeFirstResponder(view.acceptsFirstResponder ? view : nil)
    }

    /// The declared size, else the view's fitting size, else a default card.
    static func size(_ declared: CGSize?, _ view: NSView) -> CGSize {
        var size = declared ?? view.fittingSize
        if size.width < 1 || size.height < 1 { size = CGSize(width: 360, height: 240) }
        return CGSize(width: min(ceil(size.width), maxSize.width), height: min(ceil(size.height), maxSize.height))
    }

    var geometry: MountedGeometry {
        MountedGeometry(tag: window.inputTag, height: surface.bounds.height, width: surface.bounds.width)
    }

    /// The component drawn at 2x into a PNG.
    func frame() -> (png: Data, width: CGFloat, height: CGFloat)? {
        surface.layoutSubtreeIfNeeded()
        let bounds = surface.bounds
        let scale: CGFloat = 2
        guard bounds.width >= 1, bounds.height >= 1,
              let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(bounds.width * scale), pixelsHigh: Int(bounds.height * scale),
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        rep.size = bounds.size
        surface.cacheDisplay(in: bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
        return (png, bounds.width, bounds.height)
    }

    /// The visible text of the component, from its in-process accessibility tree (no
    /// system grant needed) plus AppKit text controls, for checks and for the agent.
    func texts() -> [String] {
        var seen = Set<String>(), out: [String] = [], budget = 2_000
        func add(_ value: Any?) {
            let text: String?
            switch value {
            case let string as String: text = string
            case let attributed as NSAttributedString: text = attributed.string
            case let number as NSNumber: text = number.stringValue
            default: text = nil
            }
            guard let text, !text.isEmpty, seen.insert(text).inserted else { return }
            out.append(text)
        }
        func walk(_ element: Any, depth: Int) {
            budget -= 1
            guard budget > 0, depth < 40 else { return }
            if let field = element as? NSTextField { add(field.stringValue); add(field.placeholderString) }
            if let button = element as? NSButton { add(button.title) }
            if let node = element as? NSAccessibilityProtocol {
                add(node.accessibilityLabel()); add(node.accessibilityTitle()); add(node.accessibilityValue())
            }
            var children: [Any] = []
            if let view = element as? NSView { children += view.subviews }
            if let node = element as? NSAccessibilityProtocol, let more = node.accessibilityChildren() { children += more }
            for child in children where !(child is NSView && (child as! NSView).isHidden) { walk(child, depth: depth + 1) }
        }
        walk(surface, depth: 0)
        return out
    }
}

@MainActor
final class PreviewHost {
    let previews: [TreziPreview]
    private var mounted: [String: MountedPreview] = [:]

    init(previews: [TreziPreview]) { self.previews = previews }

    func mount(_ id: String) throws -> MountedPreview {
        if let existing = mounted[id] { return existing }
        guard let index = previews.firstIndex(where: { $0.id == id }) else { throw HostFailure("No preview named \(id).") }
        let made = MountedPreview(previews[index], index: index)
        mounted[id] = made
        HostChannel.shared.remember(id, made.geometry)
        return made
    }

    func handle(_ op: String, _ request: [String: Any]) throws -> [String: Any] {
        let id = request["preview"] as? String ?? ""
        switch op {
        case "frame":
            guard let frame = try mount(id).frame() else { throw HostFailure("Could not draw \(id).") }
            return ["png": frame.png.base64EncodedString(), "width": frame.width, "height": frame.height, "scale": 2]
        case "describe":
            return ["texts": try mount(id).texts()]
        case "mount":
            let geometry = try mount(id).geometry
            return ["width": geometry.width, "height": geometry.height]
        default: throw HostFailure("Unknown request \(op).")
        }
    }

    var catalog: [[String: Any]] {
        previews.map { preview in
            var entry: [String: Any] = ["id": preview.id, "title": preview.title, "kind": preview.kind]
            if let size = preview.size { entry["width"] = size.width; entry["height"] = size.height }
            return entry
        }
    }
}

struct HostFailure: Error { let message: String; init(_ message: String) { self.message = message } }

/// The JSON-lines channel to the driver: requests on stdin, replies on the original
/// stdout. The component's own `print` output is moved to stderr, which the driver logs.
final class HostChannel: @unchecked Sendable {
    static let shared = HostChannel()
    private let lock = NSLock()
    private var output: Int32 = -1
    private var geometries: [String: MountedGeometry] = [:]

    func open() {
        output = dup(STDOUT_FILENO)
        dup2(STDERR_FILENO, STDOUT_FILENO)
        setvbuf(stdout, nil, _IOLBF, 0)
    }

    func remember(_ id: String, _ geometry: MountedGeometry) { lock.lock(); geometries[id] = geometry; lock.unlock() }

    func geometry(_ id: String) -> MountedGeometry? { lock.lock(); defer { lock.unlock() }; return geometries[id] }

    func send(_ message: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: message) else { return }
        data.append(10)
        lock.lock(); defer { lock.unlock() }
        data.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let written = write(output, raw.baseAddress! + offset, raw.count - offset)
                if written < 0 && errno == EINTR { continue }
                if written <= 0 { return }
                offset += written
            }
        }
    }

    func reply(_ id: Any?, _ result: Result<[String: Any], Error>) {
        var message: [String: Any] = ["id": id ?? NSNull()]
        switch result {
        case .success(let fields): message["ok"] = true; message.merge(fields) { _, new in new }
        case .failure(let error): message["ok"] = false; message["error"] = (error as? HostFailure)?.message ?? "\(error)"
        }
        send(message)
    }

    /// Reads requests until the driver closes stdin, then ends the host.
    func read(_ host: PreviewHost) {
        Thread.detachNewThread {
            while let line = Swift.readLine(strippingNewline: true) {
                guard let data = line.data(using: .utf8),
                      let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                      let op = request["op"] as? String else { continue }
                let id = request["id"]
                if op == "input" {
                    // Posted from this thread so a tracking loop on the main thread receives it.
                    self.reply(id, Result { try PreviewInput.post(request, channel: self) })
                    continue
                }
                let box = RequestBox(request)
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        self.reply(id, Result { try host.handle(op, box.request) })
                    }
                }
            }
            exit(0)
        }
    }
}

final class RequestBox: @unchecked Sendable { let request: [String: Any]; init(_ request: [String: Any]) { self.request = request } }
final class EventBox: @unchecked Sendable { let event: NSEvent; init(_ event: NSEvent) { self.event = event } }

/// Browser input (CSS points from the frame's top-left) as AppKit events for one preview.
enum PreviewInput {
    static func post(_ request: [String: Any], channel: HostChannel) throws -> [String: Any] {
        let id = request["preview"] as? String ?? ""
        guard let geometry = channel.geometry(id) else { throw HostFailure("Preview \(id) is not shown yet.") }
        guard let event = request["event"] as? [String: Any], let type = event["type"] as? String else { throw HostFailure("No event.") }
        let number = { (key: String) in (event[key] as? NSNumber)?.doubleValue ?? 0 }
        let location = NSPoint(x: min(max(number("x"), 0), geometry.width), y: geometry.height - min(max(number("y"), 0), geometry.height))
        var flags: NSEvent.ModifierFlags = []
        if event["shift"] as? Bool == true { flags.insert(.shift) }
        if event["alt"] as? Bool == true { flags.insert(.option) }
        if event["ctrl"] as? Bool == true { flags.insert(.control) }
        if event["meta"] as? Bool == true { flags.insert(.command) }
        let time = ProcessInfo.processInfo.systemUptime
        let made: NSEvent?
        switch type {
        case "mousedown", "mouseup", "mousedrag":
            let right = (event["button"] as? NSNumber)?.intValue == 2
            let kind: NSEvent.EventType = type == "mousedrag" ? .leftMouseDragged
                : type == "mousedown" ? (right ? .rightMouseDown : .leftMouseDown) : (right ? .rightMouseUp : .leftMouseUp)
            made = NSEvent.mouseEvent(with: kind, location: location, modifierFlags: flags, timestamp: time, windowNumber: geometry.tag,
                                      context: nil, eventNumber: 0, clickCount: max(1, Int(number("clickCount"))), pressure: kind == .leftMouseUp ? 0 : 1)
        case "keydown", "keyup":
            guard let key = Self.key(event["key"] as? String ?? "") else { return [:] }
            made = NSEvent.keyEvent(with: type == "keydown" ? .keyDown : .keyUp, location: location, modifierFlags: flags, timestamp: time,
                                    windowNumber: geometry.tag, context: nil, characters: key.characters,
                                    charactersIgnoringModifiers: key.characters, isARepeat: false, keyCode: key.code)
        case "scroll":
            // A scroll event cannot be addressed to a window: hand it to the view under the pointer.
            guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                                   wheel1: Int32(-number("dy")), wheel2: Int32(-number("dx")), wheel3: 0),
                  let scroll = NSEvent(cgEvent: cg) else { return [:] }
            let box = EventBox(scroll)
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let content = PreviewWindow.tagged(geometry.tag)?.contentView else { return }
                    content.hitTest(location)?.scrollWheel(with: box.event)
                }
            }
            return [:]
        default: throw HostFailure("Unknown input \(type).")
        }
        guard let made else { throw HostFailure("Could not make a \(type) event.") }
        NSApp.postEvent(made, atStart: false)
        return [:]
    }

    /// DOM `KeyboardEvent.key` → AppKit characters and virtual key code.
    static func key(_ key: String) -> (characters: String, code: UInt16)? {
        let special: [String: (String, UInt16)] = [
            "Enter": ("\r", 36), "Tab": ("\t", 48), "Backspace": ("\u{7F}", 51), "Escape": ("\u{1B}", 53), " ": (" ", 49),
            "Delete": (String(Character(UnicodeScalar(NSDeleteFunctionKey)!)), 117),
            "ArrowLeft": (String(Character(UnicodeScalar(NSLeftArrowFunctionKey)!)), 123),
            "ArrowRight": (String(Character(UnicodeScalar(NSRightArrowFunctionKey)!)), 124),
            "ArrowDown": (String(Character(UnicodeScalar(NSDownArrowFunctionKey)!)), 125),
            "ArrowUp": (String(Character(UnicodeScalar(NSUpArrowFunctionKey)!)), 126)
        ]
        if let mapped = special[key] { return mapped }
        return key.count == 1 ? (key, 0) : nil
    }
}

@main
enum PreviewHostMain {
    static func main() {
        HostChannel.shared.open()
        let app = PreviewHostApplication.shared
        app.setActivationPolicy(.accessory)
        MainActor.assumeIsolated {
            let host = PreviewHost(previews: TreziPreviews.all)
            HostChannel.shared.send(["type": "ready", "previews": host.catalog, "pid": Int(getpid())])
            HostChannel.shared.read(host)
        }
        app.run()
    }
}
