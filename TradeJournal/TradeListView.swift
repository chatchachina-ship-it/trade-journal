import SwiftUI
import SwiftData

struct TradeListView: View {
    @Environment(\.modelContext) private var context
    @Query(sort: \Trade.date, order: .reverse) private var trades: [Trade]
    @State private var editing: Trade?
    @State private var creating = false

    var body: some View {
        NavigationStack {
            Group {
                if trades.isEmpty {
                    ContentUnavailableView(
                        "Сделок пока нет",
                        systemImage: "chart.line.uptrend.xyaxis",
                        description: Text("Нажми «+», чтобы записать первую сделку")
                    )
                } else {
                    List {
                        ForEach(trades) { trade in
                            Button { editing = trade } label: { TradeRow(trade: trade) }
                                .tint(.primary)
                        }
                        .onDelete { offsets in
                            offsets.map { trades[$0] }.forEach(context.delete)
                        }
                    }
                }
            }
            .navigationTitle("Сделки")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { creating = true } label: { Image(systemName: "plus") }
                }
            }
            .sheet(isPresented: $creating) { TradeFormView(trade: nil) }
            .sheet(item: $editing) { TradeFormView(trade: $0) }
        }
    }
}

struct TradeRow: View {
    let trade: Trade

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(trade.symbol).font(.headline)
                    Text(trade.isLong ? "ЛОНГ" : "ШОРТ")
                        .font(.caption2.bold())
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background((trade.isLong ? Color.green : Color.red).opacity(0.15), in: Capsule())
                        .foregroundStyle(trade.isLong ? Color.green : Color.red)
                    if trade.stopPrice == nil {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                }
                Text(trade.date.formatted(date: .abbreviated, time: .shortened))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                if let pnl = trade.pnl {
                    Text(Fmt.money(pnl))
                        .font(.headline.monospacedDigit())
                        .foregroundStyle(pnl.pnlColor)
                    if let r = trade.rMultiple {
                        Text(Fmt.r(r)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }
                } else {
                    Text("Открыта").font(.subheadline).foregroundStyle(.blue)
                }
            }
        }
        .padding(.vertical, 2)
    }
}
