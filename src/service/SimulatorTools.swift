import Foundation

/// Pure simulator helpers (Xcode failures, control commands, `testID` stamps, idb
/// arguments, the bridge page), ported from the retired TS simulator runner. Kept free
/// of effects so the fixture checks them directly.
enum SimulatorTools {
    // MARK: Xcode failures

    static func xcodeFailureReason(message: String, stderr: String, missing: Bool) -> String {
        let text = "\(stderr) \(message)".lowercased()
        if text.contains("license") {
            return "Xcode is installed, but its license has not been accepted. Run `sudo xcodebuild -license accept` in a terminal, then reopen the project."
        }
        if missing || ["xcode-select", "unable to find utility", "no developer tools", "cannot be located", "command line tools"].contains(where: text.contains) {
            return "Xcode is not installed or not selected. Install the full Xcode app, then run `sudo xcode-select -s /Applications/Xcode.app` and `xcodebuild -runFirstLaunch`."
        }
        return "Could not run the iOS simulator tools: \(message)"
    }

    private static let signal = try! NSRegularExpression(pattern:
        #"(dyld\[|Library not loaded|Reason: tried:|Abort trap|PhaseScriptExecution failed|Node found at:|fatal error:|\berror:|^ld: |Undefined symbol|The following build commands failed|Command .* failed with|No such file or directory|EADDRINUSE|command not found)"#,
        options: [.caseInsensitive, .anchorsMatchLines])
    private static let noise = try! NSRegularExpression(pattern: "(Explicit dependency on target|Target dependency graph|Prepare packages)", options: .caseInsensitive)

    static func matches(_ expression: NSRegularExpression, _ text: String) -> Bool {
        expression.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)) != nil
    }

    /// JS `slice(-max)` on UTF-16 units.
    static func tail(_ text: String, _ max: Int) -> String {
        let units = Array(text.utf16)
        return units.count <= max ? text : String(decoding: units[(units.count - max)...], as: UTF16.self)
    }

    static func extractBuildError(_ log: String, max: Int = 1400) -> String {
        if log.isEmpty { return "" }
        let lines = log.components(separatedBy: "\n")
        var keep = Set<Int>()
        for index in lines.indices where !matches(noise, lines[index]) && matches(signal, lines[index]) {
            keep.insert(index)
            var next = index + 1
            while next <= Swift.min(index + 2, lines.count - 1) { if !matches(noise, lines[next]) { keep.insert(next) }; next += 1 }
        }
        if keep.isEmpty { return tail(log, max).trimmingCharacters(in: .whitespacesAndNewlines) }
        var out = keep.sorted().map { trimEnd(lines[$0]) }.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        if out.utf16.count > max { out = "…\n" + tail(out, max).trimmingCharacters(in: .whitespacesAndNewlines) }
        return out
    }

    static func trimEnd(_ text: String) -> String {
        var value = Substring(text)
        while let last = value.last, last.isWhitespace { value.removeLast() }
        return String(value)
    }

    static func parseVersion(_ value: String?) -> [Int]? {
        guard let value, let range = value.range(of: #"\d+(?:\.\d+)*"#, options: .regularExpression) else { return nil }
        return value[range].split(separator: ".").map { Int($0) ?? 0 }
    }

    static func compare(_ a: [Int], _ b: [Int]) -> Int {
        for index in 0..<Swift.max(a.count, b.count) {
            let difference = (index < a.count ? a[index] : 0) - (index < b.count ? b[index] : 0)
            if difference != 0 { return difference }
        }
        return 0
    }

    static func buildDestination(sdk sdkVersion: String?, runtimes: [String]) -> String? {
        guard let sdk = parseVersion(sdkVersion) else { return nil }
        let parsed = runtimes.compactMap(parseVersion)
        if parsed.contains(where: { compare($0, sdk) >= 0 }) { return nil }
        let newest = parsed.sorted { compare($0, $1) < 0 }.last.map { $0.map(String.init).joined(separator: ".") }
        let have = newest.map { " (newest installed is iOS \($0))" } ?? " (none installed)"
        return "Xcode's iOS SDK is \(sdk.map(String.init).joined(separator: ".")), but no matching simulator runtime is installed\(have). "
            + "Builds need a runtime ≥ the SDK version. Download it with `xcodebuild -downloadPlatform iOS` "
            + "(or Xcode → Settings → Components → Get the iOS simulator), then reopen the project."
    }

    // MARK: Metro output

    static let ready = try! NSRegularExpression(pattern:
        #"(Bundling complete|Bundled .* in \d|Logs for your project|Waiting on|Metro waiting|exp:\/\/|› Press|Opening on)"#, options: .caseInsensitive)
    static let buildFailed = try! NSRegularExpression(pattern: #"(error: |Build failed|Command .* failed|xcodebuild: error)"#, options: .caseInsensitive)

    /// The device Expo names in `…on iPhone 16 Pro (…)`.
    static func launchedDevice(_ line: String) -> String? {
        guard let match = try! NSRegularExpression(pattern: #"\bon (iPhone[\w .]+?)(?:\s*\(|$)"#, options: .caseInsensitive)
            .firstMatch(in: line, range: NSRange(location: 0, length: (line as NSString).length)) else { return nil }
        return (line as NSString).substring(with: match.range(at: 1)).trimmingCharacters(in: .whitespaces)
    }

    // MARK: Control commands (the bridge page → idb)

    enum Command: Equatable {
        case tap(Double, Double)
        case swipe(Double, Double, Double, Double, Double?)
        case text(String)
    }

    /// `parseControlCommand`: finite numbers only, else nil.
    static func command(_ body: JSValue) -> Command? {
        func number(_ key: String) -> Double? { if case .number(let value)? = body[key], value.isFinite { return value }; return nil }
        switch body["type"]?.text?.string {
        case "tap": if let x = number("x"), let y = number("y") { return .tap(x, y) }
        case "swipe": if let x = number("x"), let y = number("y"), let x2 = number("x2"), let y2 = number("y2") { return .swipe(x, y, x2, y2, number("duration")) }
        case "text": if let text = body["text"]?.text { return .text(text.string) }
        default: break
        }
        return nil
    }

    static func points(_ fx: Double, _ fy: Double, _ size: (width: Double, height: Double)) -> (Int, Int) {
        let clamp = { (value: Double) in value < 0 ? 0 : value > 1 ? 1 : value }
        return (Int((clamp(fx) * size.width).rounded(.toNearestOrAwayFromZero)), Int((clamp(fy) * size.height).rounded(.toNearestOrAwayFromZero)))
    }

    /// `idbUiArgs`: `--udid` follows the `ui <cmd>` subcommand (idb rejects it earlier).
    static func idbArguments(udid: String, _ command: Command, size: (width: Double, height: Double)) -> [String] {
        switch command {
        case let .tap(x, y):
            let point = points(x, y, size)
            return ["ui", "tap", "--udid", udid, String(point.0), String(point.1)]
        case let .swipe(x, y, x2, y2, duration):
            let a = points(x, y, size), b = points(x2, y2, size)
            return ["ui", "swipe", "--udid", udid, String(a.0), String(a.1), String(b.0), String(b.1), "--duration", number(duration ?? 0.25)]
        case .text(let text):
            // Bounded (UTF-16 units, as the JS slice) so a flood of keystrokes can't build a huge argument.
            return ["ui", "text", "--udid", udid, String(decoding: Array(text.utf16.prefix(500)), as: UTF16.self)]
        }
    }

    /// JS `String(number)` for the values a swipe duration takes.
    static func number(_ value: Double) -> String {
        value.rounded() == value && abs(value) < 1e15 ? String(Int64(value)) : String(value)
    }

    /// Device points from `idb describe --json` (pixels ÷ density).
    static func screenPoints(_ describe: JSValue) -> (width: Double, height: Double) {
        let screen = describe["screen_dimensions"]
        func value(_ key: String) -> Double? { if case .number(let n)? = screen?[key] { return n }; return nil }
        let density = (value("density") ?? 0) > 0 ? value("density")! : 1
        return (((value("width") ?? 390 * density) / density).rounded(.toNearestOrAwayFromZero),
                ((value("height") ?? 844 * density) / density).rounded(.toNearestOrAwayFromZero))
    }

    // MARK: Element select

    /// `parseTestId`: `trezi:path:line[:col]` → `path:line[:col]`.
    static func source(testID: String) -> String? {
        guard let prefix = ["trezi:", "praxis:"].first(where: testID.hasPrefix) else { return nil }
        let source = String(testID.dropFirst(prefix.count))
        return source.range(of: #"^[\w./@-]+:\d+(:\d+)?$"#, options: .regularExpression) != nil ? source : nil
    }

    /// `findTreziStamp`: the first stamp anywhere in an idb accessibility node (depth ≤ 6).
    static func stamp(_ node: JSValue, depth: Int = 0) -> String? {
        guard depth <= 6 else { return nil }
        switch node {
        case .string(let text):
            let value = text.string
            return value.hasPrefix("trezi:") || value.hasPrefix("praxis:") ? value : nil
        case .array(let values): return values.lazy.compactMap { stamp($0, depth: depth + 1) }.first
        case .object(let fields): return fields.lazy.compactMap { stamp($0.1, depth: depth + 1) }.first
        default: return nil
        }
    }

    static let staleIdb = try! NSRegularExpression(pattern: "Mach port not connected|device may not be ready|Failed to connect to companion", options: .caseInsensitive)

    // MARK: The bridge page

    /// The bezel the page draws around the mirror, proposed by Bun (`src/shared/iphone-frame.ts`).
    struct Frame {
        let uri: String
        let left: Double, top: Double, right: Double, bottom: Double
        let aspect: Double

        /// A `data:image/…;base64,` URI (no markup characters) and sane geometry, else nil.
        init?(_ value: JSValue?) {
            guard let value, let uri = value["uri"]?.text?.string, uri.utf8.count <= 512 * 1024,
                  uri.range(of: #"^data:image/(png|svg\+xml|webp);base64,[A-Za-z0-9+/=]+$"#, options: .regularExpression) != nil,
                  case .number(let aspect)? = value["aspect"], aspect.isFinite, aspect > 0.1, aspect < 10,
                  let inset = value["inset"] else { return nil }
            var sides: [Double] = []
            for key in ["left", "top", "right", "bottom"] {
                guard case .number(let side)? = inset[key], side.isFinite, side >= 0, side < 50 else { return nil }
                sides.append(side)
            }
            self.uri = uri; self.aspect = aspect
            left = sides[0]; top = sides[1]; right = sides[2]; bottom = sides[3]
        }
    }

    static func css(_ value: Double) -> String { number(value) }

    /// `pageHtml(interactive, token)` from the retired simulator.ts, byte for byte apart from the
    /// frame values it is handed.
    static func page(interactive: Bool, token: String, frame: Frame) -> String {
        let quoted = String(decoding: JSValue.string(JSText(token)).utf8(), as: UTF8.self)
        return """
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Simulator</title>
    <style>
      html, body { margin: 0; height: 100%; background: #fff; }
      body { display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; }
      #device { position: relative; aspect-ratio: \(css(frame.aspect)); height: 100%; max-width: 100%; margin: 0 auto; container-type: size; }
      #screen-box { position: absolute; left: \(css(frame.left))%; top: \(css(frame.top))%; right: \(css(frame.right))%; bottom: \(css(frame.bottom))%;
        overflow: hidden; border-radius: 9cqw; background: #000; }
      #screen { width: 100%; height: 100%; object-fit: fill; display: block; -webkit-user-select: none; }
      #bezel { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; -webkit-user-select: none; }
      #hint { position: fixed; bottom: 8px; left: 50%; transform: translateX(-50%);
        font: 11px -apple-system, system-ui, sans-serif; color: #666; background: rgba(255,255,255,.85);
        border: 1px solid #eee; border-radius: 6px; padding: 3px 8px; pointer-events: none; }
    </style>
  </head>
  <body>
    <div id="device">
      <div id="screen-box">
        <img id="screen" src="/stream?token=\(token)" alt="iOS Simulator" draggable="false" tabindex="0" />
      </div>
      <img id="bezel" src="\(frame.uri)" alt="" draggable="false" />
    </div>
    <div id="hint"\(interactive ? " hidden" : "")>View-only — install <code>idb</code> for tap &amp; type</div>
    <script>
      var INTERACTIVE = \(interactive ? "true" : "false");
      var TOKEN = \(quoted);
      window.__TREZI_SIM_TOKEN = TOKEN;
      var img = document.getElementById('screen');
      var hintEl = document.getElementById('hint');
      var hintTimer = null;
      function flashHint(text) {
        if (!INTERACTIVE) return;
        hintEl.textContent = text; hintEl.hidden = false;
        clearTimeout(hintTimer);
        hintTimer = setTimeout(function () { hintEl.hidden = true; }, 4000);
      }
      function post(cmd) {
        if (!INTERACTIVE) return;
        fetch('/control?token=' + encodeURIComponent(TOKEN), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) })
          .then(function (r) { return r.json(); })
          .then(function (j) { if (j && j.ok === false) flashHint('Interaction failed: ' + (j.error || 'unknown error')); })
          .catch(function(){});
      }
      function frac(clientX, clientY) {
        var r = img.getBoundingClientRect();
        var x = (clientX - r.left) / r.width, y = (clientY - r.top) / r.height;
        if (x < 0 || x > 1 || y < 0 || y > 1) return null;
        return { x: x, y: y };
      }
      var down = null;
      img.addEventListener('pointerdown', function (e) { down = frac(e.clientX, e.clientY); img.focus(); });
      img.addEventListener('pointerup', function (e) {
        if (!down) { down = null; return; }
        var up = frac(e.clientX, e.clientY) || down;
        var dx = up.x - down.x, dy = up.y - down.y;
        if (Math.abs(dx) + Math.abs(dy) > 0.03) post({ type: 'swipe', x: down.x, y: down.y, x2: up.x, y2: up.y });
        else post({ type: 'tap', x: up.x, y: up.y });
        down = null;
      });
      img.addEventListener('wheel', function (e) {
        var f = frac(e.clientX, e.clientY); if (!f) return;
        e.preventDefault();
        var dy = Math.max(-0.4, Math.min(0.4, -e.deltaY / 600));
        var dx = Math.max(-0.4, Math.min(0.4, -e.deltaX / 600));
        post({ type: 'swipe', x: f.x, y: f.y, x2: f.x + dx, y2: f.y + dy, duration: 0.1 });
      }, { passive: false });
      img.addEventListener('keydown', function (e) {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key && e.key.length === 1) { post({ type: 'text', text: e.key }); e.preventDefault(); }
      });
    </script>
  </body>
</html>
"""
    }
}
