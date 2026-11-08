import SwiftUI
import SwiftData
import Charts

struct StatsView: View {
    enum Period: String, CaseIterable, Identifiable {
        case week = "Неделя", month = "Месяц", all = "Всё время"
        var id: Self { self }

        var start: Date? {
            let cal = Calendar.current
            switch self {
            case .week: return cal.date(byAdding: .day, value: -7, to: .now)
            case .month: return cal.date(byAdding: .month, value: -1, to: .now)
            case .all: return nil
            }
        }
    }

    @Query(sort: \Trade.date) private var all: [Trade]
    @State private var period: Period = .week

    private var stats: TradeStats {
        TradeStats(all.filter { trade in period.start.map { trade.date >= $0 } ?? true })
    }

    var body: some View {
        let stats = self.stats
        NavigationStack {
            List {
                Section {
                    Picker("Период", selection: $period) {
                        ForEach(Period.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }

                if stats.count == 0 {
                    ContentUnavailableView(
                        "Нет закрытых сделок",
                        systemImage: "chart.bar.xaxis",
                        description: Text("Статистика появится, когда закроешь первую сделку за этот период")
                    )
                    .listRowBackground(Color.clear)
                } else {
                    Section {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Итог").font(.caption).foregroundStyle(.secondary)
                            Text(Fmt.money(stats.net))
                                .font(.system(size: 36, weight: .bold).monospacedDigit())
                                .foregroundStyle(stats.net.pnlColor)
                        }
                        .padding(.vertical, 4)
                        LabeledContent("Сделок", value: "\(stats.count)")
                        if let w = stats.winRate { LabeledContent("Винрейт", value: Fmt.percent(w)) }
                        if let r = stats.avgR { LabeledContent("Средний R", value: Fmt.r(r)) }
                        if let pf = stats.profitFactor { LabeledContent("Профит-фактор", value: Fmt.number(pf)) }
                        if let w = stats.avgWin { LabeledContent("Средняя прибыль", value: Fmt.money(w)) }
                        if let l = stats.avgLoss { LabeledContent("Средний убыток", value: Fmt.money(l)) }
                        LabeledContent("Макс. просадка", value: Fmt.money(stats.maxDrawdown))
                    }

                    if stats.count > 1 {
                        Section("Кривая капитала") {
                            Chart(stats.equity) { point in
                                AreaMark(x: .value("Сделка", point.id), y: .value("PnL", point.value))
                                    .foregroundStyle(.green.opacity(0.15))
                                LineMark(x: .value("Сделка", point.id), y: .value("PnL", point.value))
                                    .foregroundStyle(.green)
                                RuleMark(y: .value("Ноль", 0))
                                    .foregroundStyle(Color.secondary.opacity(0.4))
                            }
                            .chartXAxisLabel("сделка №")
                            .frame(height: 180)
                            .padding(.vertical, 8)
                        }
                    }

                    Section("Дисциплина") {
                        LabeledContent("Без стопа") {
                            Text("\(stats.withoutStop)").foregroundStyle(stats.withoutStop > 0 ? Color.orange : Color.secondary)
                        }
                        LabeledContent("Не по плану") {
                            Text("\(stats.offPlanCount) · \(Fmt.money(stats.offPlanPnl))")
                                .foregroundStyle(stats.offPlanPnl.pnlColor)
                        }
                        ForEach(stats.byEmotion) { row in
                            LabeledContent("\(row.emotion.rawValue) (\(row.count))") {
                                Text(Fmt.money(row.pnl)).foregroundStyle(row.pnl.pnlColor)
                            }
                        }
                    }

                    Section("Выводы") {
                        ForEach(stats.insights, id: \.self) { Text($0).font(.callout) }
                    }
                }
            }
            .navigationTitle("Статистика")
        }
    }
}
