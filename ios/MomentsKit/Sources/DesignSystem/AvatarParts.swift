import Foundation

/// The face a guest's avatar seed picks, exactly as the web draws it
/// (`src/client/lib/avatar.ts`: DiceBear 9 `funEmoji` with the curated eyes
/// and mouths). Faces are made on device from the seed; nothing is fetched.
///
/// Checked against fixtures generated from the web code
/// (`npm run avatar:fixtures`), so both apps show the same face.
public struct AvatarParts: Equatable, Sendable {
    public let eyes: AvatarEyes
    public let mouth: AvatarMouth
    public let background: AvatarBackground

    /// The parts for `seed`, in DiceBear's order of random picks: mouth,
    /// eyes, background type, then the background colors.
    public init(seed: String) {
        var random = DiceBearRandom(seed: seed)
        mouth = random.pick(AvatarMouth.allCases)
        eyes = random.pick(AvatarEyes.allCases)
        // The background type (always "solid"): one pick from one choice.
        _ = random.next()
        // DiceBear shuffles the colors twice and keeps the first.
        _ = random.shuffled(AvatarBackground.allCases)
        background = random.shuffled(AvatarBackground.allCases)[0]
    }
}

extension AvatarParts {
    /// Exact parts, for tests and previews.
    init(eyes: AvatarEyes, mouth: AvatarMouth, background: AvatarBackground) {
        self.eyes = eyes
        self.mouth = mouth
        self.background = background
    }
}

/// The web's `AVATAR_EYES`, in its order (the order changes the pick).
public enum AvatarEyes: String, CaseIterable, Sendable {
    case cute, wink, wink2, plain, glasses, closed, love, stars, shades, closed2
}

/// The web's `AVATAR_MOUTH`, in its order (the order changes the pick).
public enum AvatarMouth: String, CaseIterable, Sendable {
    case plain, lilSmile, shy, cute, wideSmile, shout, smileTeeth, smileLol, tongueOut, kissHeart
}

/// funEmoji's default background colors, in its order.
public enum AvatarBackground: String, CaseIterable, Sendable {
    case yellow = "#fcbc34"
    case purple = "#d84be5"
    case tan = "#d9915b"
    case sand = "#f6d594"
    case blue = "#059ff2"
    case green = "#71cf62"

    /// Red, green and blue in 0...1.
    public var rgb: (red: Double, green: Double, blue: Double) {
        let value = hex
        return (Double((value >> 16) & 0xff) / 255, Double((value >> 8) & 0xff) / 255, Double(value & 0xff) / 255)
    }

    /// The color as 0xRRGGBB; a test checks it against `rawValue`.
    var hex: Int {
        switch self {
        case .yellow: 0xfcbc34
        case .purple: 0xd84be5
        case .tan: 0xd9915b
        case .sand: 0xf6d594
        case .blue: 0x059ff2
        case .green: 0x71cf62
        }
    }
}

/// DiceBear 9's seeded generator (`@dicebear/core` `utils/prng.js`): a
/// 32-bit xorshift seeded by a hash of the seed's UTF-16 code units, with
/// JavaScript's wrapping 32-bit integer math.
struct DiceBearRandom {
    private static let minValue = Double(Int32.min)
    private static let maxValue = Double(Int32.max)
    /// DiceBear reads at most this many UTF-16 code units of a seed.
    private static let maxSeedLength = 1024

    private var value: Int32

    init(seed: String) {
        var hash: Int32 = 0
        for unit in seed.utf16.prefix(Self.maxSeedLength) {
            hash = Self.xorshift((hash &<< 5) &- hash &+ Int32(unit))
        }
        value = hash == 0 ? 1 : hash
    }

    private static func xorshift(_ input: Int32) -> Int32 {
        var value = input
        value ^= value &<< 13
        value ^= value >> 17
        value ^= value &<< 5
        return value
    }

    mutating func next() -> Int32 {
        value = Self.xorshift(value)
        return value
    }

    /// An integer in `lower...upper`. JavaScript can return `upper + 1` when
    /// the generator hits Int32.max (a 1-in-2³² case); that is clamped here.
    mutating func integer(_ lower: Int, _ upper: Int) -> Int {
        let unit = (Double(next()) - Self.minValue) / (Self.maxValue - Self.minValue)
        let picked = Int((unit * Double(upper + 1 - lower) + Double(lower)).rounded(.down))
        return min(picked, upper)
    }

    mutating func pick<Element>(_ elements: [Element]) -> Element {
        elements[integer(0, elements.count - 1)]
    }

    /// Fisher–Yates with a second generator seeded by one draw, as DiceBear does.
    mutating func shuffled<Element>(_ elements: [Element]) -> [Element] {
        var inner = DiceBearRandom(seed: String(next()))
        var result = elements
        for index in stride(from: result.count - 1, to: 0, by: -1) {
            result.swapAt(index, inner.integer(0, index))
        }
        return result
    }
}
