import SwiftUI

public struct Profile: Equatable {
    public var id: String
    public var name: String
    public var role: String
    public var followers: Int

    public init(id: String, name: String, role: String, followers: Int) {
        self.id = id; self.name = name; self.role = role; self.followers = followers
    }

    public var initials: String { name.split(separator: " ").compactMap(\.first).prefix(2).map(String.init).joined() }
}

/// The card's dependency: where follower counts come from.
public protocol ProfileService {
    func followers(for id: String, following: Bool, base: Int) -> Int
}

public final class ProfileModel: ObservableObject {
    @Published public var profile: Profile
    @Published public var isFollowing = false
    @Published public var note = ""
    private let service: ProfileService

    public init(profile: Profile, service: ProfileService) {
        self.profile = profile
        self.service = service
    }

    public func toggleFollow() {
        isFollowing.toggle()
        profile.followers = service.followers(for: profile.id, following: isFollowing, base: profile.followers)
    }
}

/// A SwiftUI profile card with a follow button and a note field.
public struct ProfileCard: View {
    @ObservedObject var model: ProfileModel

    public init(model: ProfileModel) { self.model = model }

    public var body: some View {
        VStack(spacing: 10) {
            Text(model.profile.initials)
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 56, height: 56)
                .background(Circle().fill(Color.indigo))
            Text(model.profile.name).font(.title2.weight(.semibold))
            Text(model.profile.role).foregroundStyle(.secondary)
            Text("\(model.profile.followers) followers").font(.callout)
            Button(model.isFollowing ? "Following" : "Follow") { model.toggleFollow() }
                .buttonStyle(.bordered)
            TextField("Add a note", text: $model.note)
                .textFieldStyle(.roundedBorder)
                .frame(width: 220)
            Text(model.note.isEmpty ? "No note yet" : "Note: \(model.note)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(20)
    }
}
