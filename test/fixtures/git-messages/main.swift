import Foundation

// Driver around GitMessages (LKM-150): a JSON array of cases on stdin, a JSON array
// of answers on stdout. `kind: "push"` asks pushRejected, anything else parses a
// `git apply` stderr against its patch and scratch patch path.

let input = FileHandle.standardInput.readDataToEndOfFile()
let cases = (try? JSONSerialization.jsonObject(with: input)) as? [[String: Any]] ?? []
let answers: [[String: Any]] = cases.map { item in
    let stderr = item["stderr"] as? String ?? ""
    if item["kind"] as? String == "push" { return ["rejected": GitMessages.pushRejected(stderr)] }
    let patchFile = item["patchFile"] as? String
    let problems = GitMessages.applyProblems(stderr, patchFile: patchFile, patch: Data((item["patch"] as? String ?? "").utf8))
    return [
        "problems": problems.map { problem -> [String: Any] in
            ["reason": problem.reason.rawValue, "file": problem.file.map { $0 as Any } ?? NSNull(),
             "line": problem.line.map { $0 as Any } ?? NSNull(), "text": problem.text]
        },
        "message": GitMessages.applyReason(problems, stderr: stderr, patchFile: patchFile),
        "unreadable": problems.contains(where: \.unreadable),
        "scrubbed": GitMessages.scrub(stderr, patchFile: patchFile),
    ]
}
FileHandle.standardOutput.write((try? JSONSerialization.data(withJSONObject: answers)) ?? Data("[]".utf8))
