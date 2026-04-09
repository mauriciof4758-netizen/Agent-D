// PlagueAIModel.swift
// Wraps the Core ML model for inference.
//
// Expects PlagueAI.mlpackage in the app bundle (add it via Xcode).
// Falls back to a built-in rule-based heuristic when the model is absent
// so the app is immediately usable even before you train the neural network.

import CoreML
import Foundation

// MARK: - Recommendation result

struct Recommendation {
    let actionIndex: Int
    let actionName: String
    let dnaCost: Int
    let confidence: Double          // 0-1, from softmax of Q-values
    let qValues: [Double]           // raw Q-values for all 25 actions
    let reasoning: String
    let isValid: Bool               // false if action is blocked/unaffordable
    let source: String              // "Neural Network" | "Heuristic"
}

// MARK: - Model wrapper

final class PlagueAIModel: ObservableObject {

    @Published var lastRecommendation: Recommendation? = nil
    @Published var isModelLoaded = false

    private var mlModel: MLModel? = nil

    init() {
        loadModel()
    }

    // ---------------------------------------------------------------------------
    // Load .mlpackage / .mlmodelc from app bundle
    // ---------------------------------------------------------------------------
    private func loadModel() {
        guard let url = Bundle.main.url(forResource: "PlagueAI", withExtension: "mlmodelc")
                     ?? Bundle.main.url(forResource: "PlagueAI", withExtension: "mlpackage") else {
            print("PlagueAI model not found in bundle — using heuristic fallback.")
            return
        }
        do {
            let config = MLModelConfiguration()
            config.computeUnits = .cpuAndNeuralEngine  // use Apple Neural Engine when available
            mlModel = try MLModel(contentsOf: url, configuration: config)
            isModelLoaded = true
            print("Core ML model loaded successfully.")
        } catch {
            print("Failed to load Core ML model: \(error). Using heuristic fallback.")
        }
    }

    // ---------------------------------------------------------------------------
    // Main inference entry point
    // ---------------------------------------------------------------------------
    func recommend(for state: GameState) {
        let valid = state.validActions()

        if let model = mlModel {
            lastRecommendation = runNeuralNetwork(model: model, state: state, valid: valid)
        } else {
            lastRecommendation = runHeuristic(state: state, valid: valid)
        }
    }

    // ---------------------------------------------------------------------------
    // Neural network inference
    // ---------------------------------------------------------------------------
    private func runNeuralNetwork(model: MLModel, state: GameState, valid: [Int]) -> Recommendation {
        let features = state.featureVector()

        do {
            // Build MLMultiArray input
            let inputArray = try MLMultiArray(shape: [1, NSNumber(value: STATE_SIZE)], dataType: .float32)
            for (i, v) in features.enumerated() {
                inputArray[i] = NSNumber(value: v)
            }

            let inputProvider = try MLDictionaryFeatureProvider(dictionary: ["game_state": inputArray])
            let output = try model.prediction(from: inputProvider)

            guard let qArray = output.featureValue(for: "q_values")?.multiArrayValue else {
                return runHeuristic(state: state, valid: valid)
            }

            // Extract Q-values
            var qValues = [Double]()
            for i in 0..<ACTION_SIZE {
                qValues.append(qArray[i].doubleValue)
            }

            // Mask invalid actions with -∞ before softmax
            var maskedQ = qValues
            for i in 0..<ACTION_SIZE {
                if !valid.contains(i) {
                    maskedQ[i] = -1e9
                }
            }

            // Softmax for confidence
            let maxQ = maskedQ.max() ?? 0.0
            let exp = maskedQ.map { Darwin.exp($0 - maxQ) }
            let sumExp = exp.reduce(0, +)
            let softmax = exp.map { $0 / sumExp }

            let best = valid.max(by: { maskedQ[$0] < maskedQ[$1] }) ?? 0
            let info = ALL_ACTIONS[best]

            return Recommendation(
                actionIndex: best,
                actionName: info.name,
                dnaCost: info.cost,
                confidence: softmax[best],
                qValues: qValues,
                reasoning: buildReasoning(action: best, state: state, confidence: softmax[best]),
                isValid: true,
                source: "Neural Network"
            )
        } catch {
            print("Inference error: \(error)")
            return runHeuristic(state: state, valid: valid)
        }
    }

    // ---------------------------------------------------------------------------
    // Rule-based heuristic fallback (works without a trained model)
    // ---------------------------------------------------------------------------
    private func runHeuristic(state: GameState, valid: [Int]) -> Recommendation {
        let infected = state.infectedPct
        let cure = state.cureProgress
        let dna = state.dnaPoints

        var scores = [Double](repeating: 0.0, count: ACTION_SIZE)

        // Priority rules
        for i in valid where i != 0 {
            let a = ALL_ACTIONS[i]
            var score = 0.0

            // Early game: spread before detection
            if infected < 10 {
                score += a.infectivityDelta * 100
                score -= a.visibilityDelta * 80   // avoid detection
            } else if infected < 50 {
                score += a.infectivityDelta * 60
                score += a.cureSlowDelta * 50
                score -= a.visibilityDelta * 20
            } else {
                // Late game: kill and slow cure
                score += a.lethalityDelta * 80
                score += a.cureSlowDelta * 70
                score += a.infectivityDelta * 30
            }

            // If cure is accelerating, prioritise slowing it
            if cure > 30 {
                score += a.cureSlowDelta * (cure / 10.0)
            }
            if cure > 60 && i == 23 {  // Gen. Re-shuffle is very valuable
                score += 200
            }

            scores[i] = score
        }

        let best = valid.max(by: { scores[$0] < scores[$1] }) ?? 0
        let info = ALL_ACTIONS[best]
        let maxScore = scores.max() ?? 1.0
        let confidence = maxScore > 0 ? min(0.99, scores[best] / maxScore) : 0.5

        return Recommendation(
            actionIndex: best,
            actionName: info.name,
            dnaCost: info.cost,
            confidence: confidence,
            qValues: scores,
            reasoning: buildReasoning(action: best, state: state, confidence: confidence),
            isValid: true,
            source: "Heuristic"
        )
    }

    // ---------------------------------------------------------------------------
    // Generate a human-readable explanation for the recommended action
    // ---------------------------------------------------------------------------
    private func buildReasoning(action: Int, state: GameState, confidence: Double) -> String {
        let pct = Int(confidence * 100)
        let a = ALL_ACTIONS[action]

        switch action {
        case 0:
            return "Saving DNA points. No upgrade is worth buying right now (\(pct)% confidence)."
        case 1, 2:
            return "Air transmission upgrades give the highest spread boost — especially effective in cold climates (\(pct)%)."
        case 3, 4:
            return "Water transmission boosts spread in coastal and island regions (\(pct)%)."
        case 5, 6:
            return "Drug resistance slows cure research — critical when cure progress is rising (\(pct)%)."
        case 7, 8:
            return "Cold resistance is needed to infect Europe and Russia (\(pct)%)."
        case 9, 10:
            return "Heat resistance opens Africa, India, and SE Asia — the most populous regions (\(pct)%)."
        case 11...16:
            return "'\(a.name)' increases spread (+\(a.infectivityDelta, specifier: "%.2f") infectivity) (\(pct)%)."
        case 17...20:
            return "'\(a.name)' increases lethality — use when the world is mostly infected (\(pct)%)."
        case 21, 22:
            return "Genetic hardening slows cure by \(Int(a.cureSlowDelta * 100))% cumulatively (\(pct)%)."
        case 23:
            return "Genetic Re-shuffle resets cure progress by 25% — use when cure > 50% (\(pct)%)."
        case 24:
            return "Symptom suppression hides the disease, slowing cure research (\(pct)%)."
        default:
            return "Recommended action with \(pct)% confidence."
        }
    }
}

// Helper for String interpolation with format specifier
extension String.StringInterpolation {
    mutating func appendInterpolation(_ value: Double, specifier: String) {
        appendLiteral(String(format: specifier, value))
    }
}
