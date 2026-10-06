import Foundation

// LKM-168: drives src/service/ProductLog.swift for test/product-log.mjs.
//   redact <home> <text>...   prints the redacted texts and one formatted line, as JSON
//   write <dir> <count>       writes <count> lines as "service" with a 4 KB daily cap
let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "redact":
    let home = args[1]
    let texts = args.dropFirst(2).map { ProductLog.redact($0, home: home) }
    let at = Date(timeIntervalSince1970: 1_759_701_163.5)
    let line = ProductLog.line(level: "info", process: "app", area: "chat", message: "Turn started\nby \(home)/dev/app token=abc123",
                               chat: "chat 1", turn: "t-1", at: at, home: home)
    let data = try! JSONSerialization.data(withJSONObject: ["texts": texts, "line": line])
    print(String(decoding: data, as: UTF8.self))
case "write":
    ProductLog.configure(process: "service", environment: ["TREZI_LOG_DIR": args[1]], maxBytes: 4096)
    for index in 0..<(Int(args[2]) ?? 1) {
        ProductLog.info("provider", "Helper started \(index) in \(ProductLog.accountHome)/dev/app with key=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx")
    }
    ProductLog.flush()
    print(ProductLog.configuredDirectory)
default:
    fputs("usage: product-log redact|write\n", stderr); exit(2)
}
