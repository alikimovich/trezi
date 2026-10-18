// swift-tools-version:5.9
import PackageDescription

// A local package the app's framework target depends on (LKM-275): Trezi builds it with
// `swift build` in its own derived data, and `Bundle.module` finds its resource bundle.
let package = Package(
    name: "StudioDesign",
    platforms: [.macOS(.v14)],
    products: [.library(name: "StudioDesign", targets: ["StudioDesign"])],
    targets: [.target(name: "StudioDesign", resources: [.process("Resources")])]
)
