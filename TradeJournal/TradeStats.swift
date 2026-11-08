import Foundation

struct EquityPoint: Identifiable {
    let id: Int
    let date: Date
    let value: Double
}

struct EmotionResult: Identifiable {
    let emotion: Emotion
    let count: Int
    let pnl: Double
    var id: String { emotion.id }
}

/// Статистика по закрытым сделкам.
struct TradeStats {
    let trades: [Trade]

    init(_ all: [Trade]) {
        trades = all.filter { !$0.isOpen }.sorted { $0.date < $1.date }
    }

    var count: Int { trades.count }
    private var pnls: [Double] { trades.compactMap(\.pnl) }
    private var wins: [Double] { pnls.filter { $0 > 0 } }
    private var losses: [Double] { pnls.filter { $0 < 0 } }

    var net: Double { pnls.reduce(0, +) }
    var winRate: Double? { count > 0 ? Double(wins.count) / Double(count) : nil }
    var avgWin: Double? { wins.isEmpty ? nil : wins.reduce(0, +) / Double(wins.count) }
    var avgLoss: Double? { losses.isEmpty ? nil : losses.reduce(0, +) / Double(losses.count) }

    var profitFactor: Double? {
        let lost = -losses.reduce(0, +)
        return lost > 0 ? wins.reduce(0, +) / lost : nil
    }

    var avgR: Double? {
        let rs = trades.compactMap(\.rMultiple)
        return rs.isEmpty ? nil : rs.reduce(0, +) / Double(rs.count)
    }

    var equity: [EquityPoint] {
        var total = 0.0
        return trades.enumerated().map { i, t in
            total += t.pnl ?? 0
            return EquityPoint(id: i + 1, date: t.date, value: total)
        }
    }

    /// Самое глубокое падение кривой капитала от её максимума.
    var maxDrawdown: Double {
        var peak = 0.0, worst = 0.0
        for p in equity {
            peak = max(peak, p.value)
            worst = min(worst, p.value - peak)
        }
        return worst
    }

    var withoutStop: Int { trades.filter { $0.stopPrice == nil }.count }
    var offPlanCount: Int { trades.filter { !$0.followedPlan }.count }
    var offPlanPnl: Double { trades.filter { !$0.followedPlan }.compactMap(\.pnl).reduce(0, +) }

    var byEmotion: [EmotionResult] {
        Emotion.allCases.compactMap { e in
            let group = trades.filter { $0.emotion == e }
            guard !group.isEmpty else { return nil }
            return EmotionResult(emotion: e, count: group.count, pnl: group.compactMap(\.pnl).reduce(0, +))
        }
    }

    /// Короткие выводы простыми словами.
    var insights: [String] {
        var out: [String] = []
        if withoutStop > 0 {
            out.append("\(withoutStop) из \(count) сделок без стопа. Без стопа нельзя посчитать риск, и один неудачный вход может съесть неделю.")
        }
        if offPlanCount > 0 {
            out.append("Сделки не по плану (\(offPlanCount)) дали \(Fmt.money(offPlanPnl)).")
        }
        let emotional = byEmotion.filter { $0.emotion != .calm }
        let emotionalPnl = emotional.map(\.pnl).reduce(0, +)
        if !emotional.isEmpty && emotionalPnl < 0 {
            out.append("Сделки на эмоциях в сумме: \(Fmt.money(emotionalPnl)).")
        }
        if let pf = profitFactor, pf < 1 {
            out.append("Профит-фактор ниже 1: убытки перевешивают прибыль. Стоит сократить число сделок и оставить только лучший сетап.")
        }
        if let w = avgWin, let l = avgLoss, abs(l) > w {
            out.append("Средний убыток больше средней прибыли: возможно, стопы двигаются или прибыль фиксируется слишком рано.")
        }
        if out.isEmpty && count > 0 {
            out.append("Явных проблем с дисциплиной не видно. Продолжай записывать каждую сделку.")
        }
        return out
    }
}
