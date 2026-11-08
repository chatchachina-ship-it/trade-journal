import SwiftUI
import SwiftData

@main
struct TradeJournalApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .modelContainer(for: Trade.self)
    }
}

struct ContentView: View {
    @Environment(\.modelContext) private var context

    var body: some View {
        TabView {
            TradeListView()
                .tabItem { Label("Сделки", systemImage: "list.bullet.rectangle") }
            StatsView()
                .tabItem { Label("Статистика", systemImage: "chart.xyaxis.line") }
        }
        #if DEBUG
        .onAppear { DemoData.seedIfRequested(context) }
        #endif
    }
}

#if DEBUG
/// Тестовые сделки для проверки экранов: запуск с аргументом -seedDemo.
enum DemoData {
    static func seedIfRequested(_ context: ModelContext) {
        guard ProcessInfo.processInfo.arguments.contains("-seedDemo"),
              (try? context.fetchCount(FetchDescriptor<Trade>())) == 0 else { return }
        let day: TimeInterval = 86_400
        let now = Date.now
        let trades = [
            Trade(date: now - 6 * day, symbol: "BTCUSDT", entryPrice: 100_000, exitPrice: 102_000, stopPrice: 99_000, quantity: 0.1, fees: 8, setup: "Пробой уровня"),
            Trade(date: now - 5 * day, symbol: "ETHUSDT", isLong: false, entryPrice: 3_800, exitPrice: 3_860, stopPrice: 3_850, quantity: 2, fees: 6, setup: "Ложный пробой", emotion: .greed, followedPlan: false, notes: "Передвинул стоп"),
            Trade(date: now - 4 * day, symbol: "SOLUSDT", entryPrice: 190, exitPrice: 184, quantity: 20, fees: 3, setup: "Вход по новости", emotion: .fomo, followedPlan: false),
            Trade(date: now - 3 * day, symbol: "BTCUSDT", entryPrice: 101_500, exitPrice: 103_000, stopPrice: 100_800, quantity: 0.1, fees: 8, setup: "Пробой уровня"),
            Trade(date: now - 2 * day, symbol: "EVAAUSDT", entryPrice: 1.35, exitPrice: 1.21, stopPrice: 1.30, quantity: 1_000, fees: 2, setup: "Памп", emotion: .revenge, followedPlan: false, notes: "Отыгрывался после SOL"),
            Trade(date: now - 1 * day, symbol: "ETHUSDT", entryPrice: 3_700, exitPrice: 3_760, stopPrice: 3_670, quantity: 2, fees: 6, setup: "Отскок от уровня"),
            Trade(date: now - 3_600, symbol: "BTCUSDT", entryPrice: 103_200, stopPrice: 102_500, quantity: 0.05, setup: "Пробой уровня"),
        ]
        trades.forEach(context.insert)
    }
}
#endif
