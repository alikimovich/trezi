/// The separately built library module (the shape of Scraib's ScraibKit package).
public struct Greeter: Sendable {
    public let salutation: String
    public init(salutation: String = "Hello") { self.salutation = salutation }
    public func greeting(for name: String) -> String { "\(salutation), \(name)!" }
}
