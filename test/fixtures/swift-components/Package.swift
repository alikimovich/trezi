// swift-tools-version: 5.9
import PackageDescription

// The components build as an ordinary library. `Previews/` sits outside the target, so
// only Trezi's preview host compiles it (see trezi-previews.json).
let package = Package(
    name: "DemoComponents",
    platforms: [.macOS(.v14)],
    products: [.library(name: "DemoComponents", targets: ["DemoComponents"])],
    targets: [.target(name: "DemoComponents", path: "Sources/DemoComponents")]
)
