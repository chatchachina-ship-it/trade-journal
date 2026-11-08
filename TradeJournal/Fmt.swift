import SwiftUI

enum Fmt {
    static func money(_ v: Double) -> String {
        (v > 0 ? "+" : "") + v.formatted(.number.precision(.fractionLength(2))) + " $"
    }

    static func r(_ v: Double) -> String {
        (v > 0 ? "+" : "") + v.formatted(.number.precision(.fractionLength(2))) + "R"
    }

    static func percent(_ v: Double) -> String {
        v.formatted(.percent.precision(.fractionLength(0)))
    }

    static func number(_ v: Double) -> String {
        v.formatted(.number.precision(.fractionLength(0...2)))
    }
}

extension Double {
    var pnlColor: Color { self > 0 ? .green : self < 0 ? .red : .secondary }
}
