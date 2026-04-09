// ContentView.swift
// Main SwiftUI interface for the Plague Inc. AI Advisor.
//
// Layout:
//   Tab 1 — Input: enter current game state via sliders & toggles
//   Tab 2 — Advice: AI recommendation + Q-value bar chart

import SwiftUI
import Charts

struct ContentView: View {
    @StateObject private var model = PlagueAIModel()
    @State private var gameState = GameState()
    @State private var selectedTab = 0

    var body: some View {
        TabView(selection: $selectedTab) {
            InputView(gameState: $gameState, model: model, selectedTab: $selectedTab)
                .tabItem {
                    Label("Game State", systemImage: "globe.americas.fill")
                }
                .tag(0)

            AdviceView(recommendation: model.lastRecommendation, gameState: gameState)
                .tabItem {
                    Label("AI Advice", systemImage: "brain.head.profile")
                }
                .tag(1)
        }
        .tint(.green)
    }
}

// MARK: - Input Tab

struct InputView: View {
    @Binding var gameState: GameState
    @ObservedObject var model: PlagueAIModel
    @Binding var selectedTab: Int

    var body: some View {
        NavigationStack {
            Form {
                globalStatsSection
                regionsSection
                upgradesSection
                analyzeButton
            }
            .navigationTitle("Plague Inc. AI")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    if model.isModelLoaded {
                        Label("Neural Network", systemImage: "cpu")
                            .font(.caption)
                            .foregroundStyle(.green)
                    } else {
                        Label("Heuristic Mode", systemImage: "lightbulb")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                }
            }
        }
    }

    // ---- Global stats -------------------------------------------------------
    private var globalStatsSection: some View {
        Section {
            LabeledSlider(label: "Infected", value: $gameState.infectedPct,
                          range: 0...100, unit: "%", color: .orange)
            LabeledSlider(label: "Dead", value: $gameState.deadPct,
                          range: 0...100, unit: "%", color: .red)
            LabeledSlider(label: "Cure Progress", value: $gameState.cureProgress,
                          range: 0...100, unit: "%", color: .blue)
            LabeledSlider(label: "DNA Points", value: $gameState.dnaPoints,
                          range: 0...200, unit: "", color: .green)

            HStack {
                Text("Turn")
                Spacer()
                Stepper("\(gameState.turn)", value: $gameState.turn, in: 1...MAX_TURNS)
                    .fixedSize()
            }
        } header: {
            Text("Global Statistics")
        }
    }

    // ---- Per-region infection %  --------------------------------------------
    private var regionsSection: some View {
        Section {
            ForEach(0..<REGION_NAMES.count, id: \.self) { i in
                LabeledSlider(
                    label: REGION_NAMES[i],
                    value: $gameState.regionInfected[i],
                    range: 0...100,
                    unit: "%",
                    color: regionColor(gameState.regionInfected[i])
                )
            }
        } header: {
            Text("Region Infection")
        } footer: {
            Text("Enter the current infection percentage for each region.")
                .font(.caption)
        }
    }

    private func regionColor(_ pct: Double) -> Color {
        if pct < 5 { return .gray }
        if pct < 25 { return .yellow }
        if pct < 60 { return .orange }
        return .red
    }

    // ---- Upgrade toggles  ---------------------------------------------------
    private var upgradesSection: some View {
        Section {
            ForEach(1..<ACTION_SIZE, id: \.self) { i in
                let a = ALL_ACTIONS[i]
                Toggle(isOn: $gameState.upgrades[i]) {
                    HStack {
                        Text(a.name)
                        Spacer()
                        Text("\(a.cost) DNA")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .tint(.green)
                .disabled(!canToggle(i))
            }
        } header: {
            Text("Upgrades Owned")
        } footer: {
            Text("Toggle upgrades you have already evolved in the game.")
                .font(.caption)
        }
    }

    private func canToggle(_ i: Int) -> Bool {
        if gameState.upgrades[i] { return true }
        return ALL_ACTIONS[i].prerequisites.allSatisfy { gameState.upgrades[$0] }
    }

    // ---- Analyze button  ----------------------------------------------------
    private var analyzeButton: some View {
        Section {
            Button {
                model.recommend(for: gameState)
                selectedTab = 1
            } label: {
                HStack {
                    Spacer()
                    Label("Get AI Recommendation", systemImage: "brain")
                        .font(.headline)
                    Spacer()
                }
            }
            .listRowBackground(Color.green)
            .foregroundStyle(.white)
        }
    }
}

// MARK: - Advice Tab

struct AdviceView: View {
    let recommendation: Recommendation?
    let gameState: GameState

    var body: some View {
        NavigationStack {
            Group {
                if let rec = recommendation {
                    ScrollView {
                        VStack(spacing: 20) {
                            recommendationCard(rec)
                            reasoningCard(rec)
                            qValueChart(rec)
                            top5List(rec)
                        }
                        .padding()
                    }
                } else {
                    ContentUnavailableView(
                        "No Recommendation Yet",
                        systemImage: "brain",
                        description: Text("Enter your current game state on the Game State tab, then tap Get AI Recommendation.")
                    )
                }
            }
            .navigationTitle("AI Advice")
            .navigationBarTitleDisplayMode(.large)
        }
    }

    // ---- Main recommendation card  ------------------------------------------
    private func recommendationCard(_ rec: Recommendation) -> some View {
        VStack(spacing: 12) {
            HStack {
                VStack(alignment: .leading) {
                    Text("RECOMMENDED ACTION")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(rec.actionName)
                        .font(.title)
                        .bold()
                }
                Spacer()
                VStack(alignment: .trailing) {
                    if rec.dnaCost > 0 {
                        Text("\(rec.dnaCost) DNA")
                            .font(.title2)
                            .foregroundStyle(.green)
                            .bold()
                    } else {
                        Text("Free")
                            .font(.title2)
                            .foregroundStyle(.gray)
                    }
                }
            }

            Divider()

            HStack {
                confidencePill(rec.confidence)
                Spacer()
                Text(rec.source)
                    .font(.caption)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(rec.source == "Neural Network" ? Color.green.opacity(0.2) : Color.orange.opacity(0.2))
                    .foregroundStyle(rec.source == "Neural Network" ? .green : .orange)
                    .clipShape(Capsule())
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    private func confidencePill(_ confidence: Double) -> some View {
        let pct = Int(confidence * 100)
        let color: Color = confidence > 0.7 ? .green : confidence > 0.4 ? .yellow : .orange
        return HStack(spacing: 4) {
            Image(systemName: "checkmark.seal.fill")
            Text("\(pct)% confidence")
        }
        .font(.subheadline)
        .foregroundStyle(color)
    }

    // ---- Reasoning card  ----------------------------------------------------
    private func reasoningCard(_ rec: Recommendation) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Why this action?", systemImage: "text.bubble")
                .font(.headline)
            Text(rec.reasoning)
                .font(.body)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    // ---- Q-value bar chart  -------------------------------------------------
    @ViewBuilder
    private func qValueChart(_ rec: Recommendation) -> some View {
        let validSet = Set(gameState.validActions())
        let data: [(name: String, q: Double, valid: Bool)] = rec.qValues
            .enumerated()
            .filter { validSet.contains($0.offset) }
            .sorted { $0.element > $1.element }
            .prefix(8)
            .map { (ALL_ACTIONS[$0.offset].name, $0.element, validSet.contains($0.offset)) }

        VStack(alignment: .leading, spacing: 8) {
            Label("Top Q-Values (valid actions)", systemImage: "chart.bar.fill")
                .font(.headline)

            Chart(data, id: \.name) { item in
                BarMark(
                    x: .value("Q", item.q),
                    y: .value("Action", item.name)
                )
                .foregroundStyle(item.name == rec.actionName ? Color.green : Color.blue.opacity(0.6))
            }
            .chartXAxis {
                AxisMarks(position: .bottom)
            }
            .frame(height: CGFloat(data.count) * 36 + 20)
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    // ---- Top 5 alternatives  ------------------------------------------------
    private func top5List(_ rec: Recommendation) -> some View {
        let validSet = Set(gameState.validActions())
        let ranked = rec.qValues.enumerated()
            .filter { validSet.contains($0.offset) }
            .sorted { $0.element > $1.element }
            .prefix(5)

        return VStack(alignment: .leading, spacing: 8) {
            Label("Top 5 Options", systemImage: "list.number")
                .font(.headline)

            ForEach(Array(ranked.enumerated()), id: \.offset) { rank, item in
                HStack {
                    Text("\(rank + 1).")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(width: 20)
                    Text(ALL_ACTIONS[item.offset].name)
                        .font(.subheadline)
                    Spacer()
                    Text(String(format: "%.2f", item.element))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                    if ALL_ACTIONS[item.offset].cost > 0 {
                        Text("\(ALL_ACTIONS[item.offset].cost) DNA")
                            .font(.caption)
                            .foregroundStyle(.green)
                    }
                }
                .padding(.vertical, 2)
                if rank < 4 { Divider() }
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }
}

// MARK: - Reusable components

struct LabeledSlider: View {
    let label: String
    @Binding var value: Double
    let range: ClosedRange<Double>
    let unit: String
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(label)
                    .font(.subheadline)
                Spacer()
                Text("\(Int(value))\(unit)")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(color)
            }
            Slider(value: $value, in: range)
                .tint(color)
        }
    }
}

// MARK: - Preview

#Preview {
    ContentView()
}
