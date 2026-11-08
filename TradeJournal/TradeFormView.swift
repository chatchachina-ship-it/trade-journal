import SwiftUI
import SwiftData

struct TradeFormView: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    let trade: Trade?

    @State private var date: Date
    @State private var symbol: String
    @State private var isLong: Bool
    @State private var entry: Double?
    @State private var stop: Double?
    @State private var exit: Double?
    @State private var quantity: Double?
    @State private var fees: Double?
    @State private var setup: String
    @State private var emotion: Emotion
    @State private var followedPlan: Bool
    @State private var notes: String

    init(trade: Trade?) {
        self.trade = trade
        _date = State(initialValue: trade?.date ?? .now)
        _symbol = State(initialValue: trade?.symbol ?? "")
        _isLong = State(initialValue: trade?.isLong ?? true)
        _entry = State(initialValue: trade?.entryPrice)
        _stop = State(initialValue: trade?.stopPrice)
        _exit = State(initialValue: trade?.exitPrice)
        _quantity = State(initialValue: trade?.quantity)
        _fees = State(initialValue: trade?.fees)
        _setup = State(initialValue: trade?.setup ?? "")
        _emotion = State(initialValue: trade?.emotion ?? .calm)
        _followedPlan = State(initialValue: trade?.followedPlan ?? true)
        _notes = State(initialValue: trade?.notes ?? "")
    }

    private var isValid: Bool {
        !symbol.trimmingCharacters(in: .whitespaces).isEmpty
            && (entry ?? 0) > 0
            && (quantity ?? 0) > 0
    }

    private var previewRisk: Double? {
        guard let entry, let stop, let quantity else { return nil }
        return TradeMath.risk(entry: entry, stop: stop, quantity: quantity)
    }

    private var previewPnl: Double? {
        guard let entry, let exit, let quantity else { return nil }
        return TradeMath.pnl(entry: entry, exit: exit, quantity: quantity, isLong: isLong, fees: fees ?? 0)
    }

    private var stopWarning: String? {
        guard let entry, entry > 0 else { return nil }
        guard let stop else { return "Сделка без стопа: риск не ограничен" }
        return TradeMath.stopOnWrongSide(entry: entry, stop: stop, isLong: isLong)
            ? (isLong ? "Для лонга стоп должен быть ниже входа" : "Для шорта стоп должен быть выше входа")
            : nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Инструмент") {
                    TextField("Тикер, например BTCUSDT", text: $symbol)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                    Picker("Направление", selection: $isLong) {
                        Text("Лонг").tag(true)
                        Text("Шорт").tag(false)
                    }
                    .pickerStyle(.segmented)
                    DatePicker("Дата", selection: $date)
                }

                Section {
                    priceField("Вход", value: $entry, prompt: "цена")
                    priceField("Стоп", value: $stop, prompt: "цена")
                    priceField("Выход", value: $exit, prompt: "пусто — открыта")
                    priceField("Объём", value: $quantity, prompt: "монет / акций")
                    priceField("Комиссия, $", value: $fees, prompt: "0")
                } header: {
                    Text("Цены")
                } footer: {
                    if let stopWarning {
                        Label(stopWarning, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                }

                if previewRisk != nil || previewPnl != nil {
                    Section("Расчёт") {
                        if let risk = previewRisk {
                            LabeledContent("Риск до стопа", value: Fmt.money(-risk))
                        }
                        if let pnl = previewPnl {
                            LabeledContent("Результат") {
                                Text(Fmt.money(pnl)).foregroundStyle(pnl.pnlColor)
                            }
                            if let risk = previewRisk {
                                LabeledContent("В R", value: Fmt.r(pnl / risk))
                            }
                        }
                    }
                }

                Section("Психология") {
                    TextField("Сетап, например пробой уровня", text: $setup)
                    Picker("Состояние", selection: $emotion) {
                        ForEach(Emotion.allCases) { Text($0.rawValue).tag($0) }
                    }
                    Toggle("Сделка по плану", isOn: $followedPlan)
                }

                Section("Заметки") {
                    TextField("Почему вошёл, что пошло не так…", text: $notes, axis: .vertical)
                        .lineLimit(3...8)
                }

                if let trade {
                    Section {
                        Button("Удалить сделку", role: .destructive) {
                            context.delete(trade)
                            dismiss()
                        }
                    }
                }
            }
            .navigationTitle(trade == nil ? "Новая сделка" : "Сделка")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Сохранить", action: save).disabled(!isValid)
                }
            }
        }
    }

    private func priceField(_ title: String, value: Binding<Double?>, prompt: String = "") -> some View {
        LabeledContent(title) {
            TextField(title, value: value, format: .number, prompt: Text(prompt))
                .keyboardType(.decimalPad)
                .multilineTextAlignment(.trailing)
        }
    }

    private func save() {
        let target = trade ?? Trade()
        target.date = date
        target.symbol = symbol.trimmingCharacters(in: .whitespaces).uppercased()
        target.isLong = isLong
        target.entryPrice = entry ?? 0
        target.stopPrice = stop
        target.exitPrice = exit
        target.quantity = quantity ?? 0
        target.fees = fees ?? 0
        target.setup = setup
        target.emotion = emotion
        target.followedPlan = followedPlan
        target.notes = notes
        if trade == nil { context.insert(target) }
        dismiss()
    }
}
