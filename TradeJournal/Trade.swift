import Foundation
import SwiftData

enum Emotion: String, CaseIterable, Identifiable {
    case calm = "Спокоен"
    case fear = "Страх"
    case greed = "Жадность"
    case fomo = "FOMO"
    case revenge = "Отыгрыш"

    var id: String { rawValue }
}

@Model
final class Trade {
    var date: Date
    var symbol: String
    var isLong: Bool
    var entryPrice: Double
    /// nil — сделка ещё открыта
    var exitPrice: Double?
    var stopPrice: Double?
    /// Объём позиции в монетах / акциях
    var quantity: Double
    var fees: Double
    var setup: String
    var emotionRaw: String
    var followedPlan: Bool
    var notes: String

    init(
        date: Date = .now,
        symbol: String = "",
        isLong: Bool = true,
        entryPrice: Double = 0,
        exitPrice: Double? = nil,
        stopPrice: Double? = nil,
        quantity: Double = 0,
        fees: Double = 0,
        setup: String = "",
        emotion: Emotion = .calm,
        followedPlan: Bool = true,
        notes: String = ""
    ) {
        self.date = date
        self.symbol = symbol
        self.isLong = isLong
        self.entryPrice = entryPrice
        self.exitPrice = exitPrice
        self.stopPrice = stopPrice
        self.quantity = quantity
        self.fees = fees
        self.setup = setup
        self.emotionRaw = emotion.rawValue
        self.followedPlan = followedPlan
        self.notes = notes
    }

    var emotion: Emotion {
        get { Emotion(rawValue: emotionRaw) ?? .calm }
        set { emotionRaw = newValue.rawValue }
    }

    var isOpen: Bool { exitPrice == nil }

    var pnl: Double? {
        guard let exitPrice else { return nil }
        return TradeMath.pnl(entry: entryPrice, exit: exitPrice, quantity: quantity, isLong: isLong, fees: fees)
    }

    var risk: Double? {
        guard let stopPrice else { return nil }
        return TradeMath.risk(entry: entryPrice, stop: stopPrice, quantity: quantity)
    }

    var rMultiple: Double? {
        guard let pnl, let risk, risk > 0 else { return nil }
        return pnl / risk
    }
}

/// Чистые формулы — их же использует форма для предпросмотра до сохранения.
enum TradeMath {
    static func pnl(entry: Double, exit: Double, quantity: Double, isLong: Bool, fees: Double) -> Double {
        (exit - entry) * quantity * (isLong ? 1 : -1) - fees
    }

    static func risk(entry: Double, stop: Double, quantity: Double) -> Double? {
        let r = abs(entry - stop) * quantity
        return r > 0 ? r : nil
    }

    /// Стоп должен быть ниже входа для лонга и выше — для шорта.
    static func stopOnWrongSide(entry: Double, stop: Double, isLong: Bool) -> Bool {
        isLong ? stop >= entry : stop <= entry
    }
}
