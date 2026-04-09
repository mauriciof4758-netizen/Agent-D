// GameState.swift
// Mirrors the Python simulation's state encoding for Core ML inference.
//
// The feature vector layout must exactly match plague_sim.py _get_state():
//   [0]     total_infected_pct        (0-1)
//   [1]     total_dead_pct            (0-1)
//   [2]     cure_progress             (0-1)
//   [3]     dna_points / 100          (0-1, capped)
//   [4]     turn / 500                (0-1)
//   [5-16]  per-region infected %     (12 values, 0-1 each)
//   [17]    infectivity / 0.5         (0-1)
//   [18]    lethality / 0.1           (0-1)
//   [19]    visibility                (-1 to 1)
//   [20-43] upgrades[1..24]           (24 × 0 or 1)
//   [44]    is_detected               (0 or 1)

import Foundation

// MARK: - Constants

let STATE_SIZE  = 45
let ACTION_SIZE = 25
let MAX_TURNS   = 500

// ---------------------------------------------------------------------------
// Action catalogue  (must mirror plague_sim.py ACTIONS list)
// ---------------------------------------------------------------------------
struct ActionInfo {
    let name: String
    let cost: Int
    let prerequisites: [Int]       // indices of required upgrades
    let infectivityDelta: Double
    let lethalityDelta: Double
    let visibilityDelta: Double
    let cureSlowDelta: Double
    let isSpecial: Bool            // true for Genetic Re-shuffle (resets cure)
}

let ALL_ACTIONS: [ActionInfo] = [
    ActionInfo(name: "Wait",                cost: 0,  prerequisites: [],     infectivityDelta: 0.00,  lethalityDelta: 0.000, visibilityDelta:  0.00,  cureSlowDelta: 0.00, isSpecial: false),
    ActionInfo(name: "Air Trans. 1",        cost: 3,  prerequisites: [],     infectivityDelta: 0.15,  lethalityDelta: 0.000, visibilityDelta:  0.00,  cureSlowDelta: 0.00, isSpecial: false),
    ActionInfo(name: "Air Trans. 2",        cost: 5,  prerequisites: [1],    infectivityDelta: 0.15,  lethalityDelta: 0.000, visibilityDelta:  0.00,  cureSlowDelta: 0.00, isSpecial: false),
    ActionInfo(name: "Water Trans. 1",      cost: 3,  prerequisites: [],     infectivityDelta: 0.15,  lethalityDelta: 0.000, visibilityDelta:  0.00,  cureSlowDelta: 0.00, isSpecial: false),
    ActionInfo(name: "Water Trans. 2",      cost: 5,  prerequisites: [3],    infectivityDelta: 0.15,  lethalityDelta: 0.000, visibilityDelta:  0.00,  cureSlowDelta: 0.00, isSpecial: false),
    ActionInfo(name: "Drug Resistance 1",   cost: 6,  prerequisites: [],     infectivityDelta: 0.00,  lethalityDelta: 0.000, visibilityDelta:  0.00,  cureSlowDelta: 0.20, isSpecial: false),
    ActionInfo(name: "Drug Resistance 2",   cost: 15, prerequisites: [5],    infectivityDelta: 0.00,  lethalityDelta: 0.000, visibilityDelta:  0.00,  cureSlowDelta: 0.30, isSpecial: false),
    ActionInfo(name: "Cold Resistance 1",   cost: 5,  prerequisites: [],     infectivityDelta: 0.10,  lethalityDelta: 0.000, visibilityDelta:  0.00,  cureSlowDelta: 0.00, isSpecial: false),
    ActionInfo(name: "Cold Resistance 2",   cost: 10, prerequisites: [7],    infectivityDelta: 0.10,  lethalityDelta: 0.000, visibilityDelta:  0.00,  cureSlowDelta: 0.00, isSpecial: false),
    ActionInfo(name: "Heat Resistance 1",   cost: 5,  prerequisites: [],     infectivityDelta: 0.10,  lethalityDelta: 0.000, visibilityDelta:  0.00,  cureSlowDelta: 0.00, isSpecial: false),
    ActionInfo(name: "Heat Resistance 2",   cost: 10, prerequisites: [9],    infectivityDelta: 0.10,  lethalityDelta: 0.000, visibilityDelta:  0.00,  cureSlowDelta: 0.00, isSpecial: false),
    ActionInfo(name: "Coughing",            cost: 3,  prerequisites: [],     infectivityDelta: 0.10,  lethalityDelta: 0.002, visibilityDelta:  0.05,  cureSlowDelta: 0.00, isSpecial: false),
    ActionInfo(name: "Sneezing",            cost: 2,  prerequisites: [],     infectivityDelta: 0.08,  lethalityDelta: 0.000, visibilityDelta:  0.03,  cureSlowDelta: 0.00, isSpecial: false),
    ActionInfo(name: "Rash",                cost: 2,  prerequisites: [],     infectivityDelta: 0.05,  lethalityDelta: 0.001, visibilityDelta:  0.04,  cureSlowDelta: 0.00, isSpecial: false),
    ActionInfo(name: "Sweating",            cost: 2,  prerequisites: [],     infectivityDelta: 0.03,  lethalityDelta: 0.000, visibilityDelta:  0.02,  cureSlowDelta: 0.00, isSpecial: false),
    ActionInfo(name: "Vomiting",            cost: 4,  prerequisites: [],     infectivityDelta: 0.12,  lethalityDelta: 0.003, visibilityDelta:  0.08,  cureSlowDelta: 0.00, isSpecial: false),
    ActionInfo(name: "Fever",               cost: 3,  prerequisites: [],     infectivityDelta: 0.05,  lethalityDelta: 0.002, visibilityDelta:  0.10,  cureSlowDelta: 0.00, isSpecial: false),
    ActionInfo(name: "Pneumonia",           cost: 8,  prerequisites: [11],   infectivityDelta: 0.15,  lethalityDelta: 0.010, visibilityDelta:  0.15,  cureSlowDelta: 0.00, isSpecial: false),
    ActionInfo(name: "Pulmonary Edema",     cost: 15, prerequisites: [17],   infectivityDelta: 0.05,  lethalityDelta: 0.020, visibilityDelta:  0.20,  cureSlowDelta: 0.00, isSpecial: false),
    ActionInfo(name: "Total Organ Failure", cost: 20, prerequisites: [18],   infectivityDelta: 0.00,  lethalityDelta: 0.040, visibilityDelta:  0.30,  cureSlowDelta: 0.00, isSpecial: false),
    ActionInfo(name: "Hemorrhagic Shock",   cost: 25, prerequisites: [19],   infectivityDelta: 0.05,  lethalityDelta: 0.030, visibilityDelta:  0.25,  cureSlowDelta: 0.00, isSpecial: false),
    ActionInfo(name: "Gen. Hardening 1",    cost: 10, prerequisites: [],     infectivityDelta: 0.00,  lethalityDelta: 0.000, visibilityDelta:  0.00,  cureSlowDelta: 0.25, isSpecial: false),
    ActionInfo(name: "Gen. Hardening 2",    cost: 15, prerequisites: [21],   infectivityDelta: 0.00,  lethalityDelta: 0.000, visibilityDelta:  0.00,  cureSlowDelta: 0.30, isSpecial: false),
    ActionInfo(name: "Gen. Re-shuffle",     cost: 16, prerequisites: [],     infectivityDelta: 0.00,  lethalityDelta: 0.000, visibilityDelta:  0.00,  cureSlowDelta: 0.00, isSpecial: true),
    ActionInfo(name: "Symptom Suppress.",   cost: 12, prerequisites: [],     infectivityDelta: 0.00,  lethalityDelta: 0.000, visibilityDelta: -0.50,  cureSlowDelta: 0.00, isSpecial: false),
]

// ---------------------------------------------------------------------------
// Region names (must match plague_sim.py _REGIONS_TEMPLATE order)
// ---------------------------------------------------------------------------
let REGION_NAMES = [
    "N. America", "Europe", "S. America", "Africa",
    "Middle East", "India", "China", "SE Asia",
    "Russia", "Oceania", "C. Asia", "Islands"
]

// ---------------------------------------------------------------------------
// GameState  —  the data model that drives Core ML inference
// ---------------------------------------------------------------------------
struct GameState {
    // Global stats
    var infectedPct: Double = 0.0       // 0-100
    var deadPct: Double = 0.0           // 0-100
    var cureProgress: Double = 0.0      // 0-100
    var dnaPoints: Double = 5.0         // 0-200
    var turn: Int = 1                   // 1-500

    // Per-region infected %  (0-100 each, order = REGION_NAMES)
    var regionInfected: [Double] = Array(repeating: 0.0, count: 12)

    // Upgrades owned (index 0 unused, indices 1-24 correspond to ALL_ACTIONS)
    var upgrades: [Bool] = Array(repeating: false, count: ACTION_SIZE)

    // Derived disease parameters (computed from owned upgrades)
    var infectivity: Double {
        var v = 0.05
        for i in 1..<ACTION_SIZE where upgrades[i] {
            v += ALL_ACTIONS[i].infectivityDelta
        }
        return v
    }

    var lethality: Double {
        var v = 0.001
        for i in 1..<ACTION_SIZE where upgrades[i] {
            v += ALL_ACTIONS[i].lethalityDelta
        }
        return v
    }

    var visibility: Double {
        var v = 0.0
        for i in 1..<ACTION_SIZE where upgrades[i] {
            v += ALL_ACTIONS[i].visibilityDelta
        }
        return max(-1.0, min(1.0, v))
    }

    var isDetected: Bool {
        cureProgress > 0.0
    }

    // ---------------------------------------------------------------------------
    // Build the 45-float input vector for Core ML — must match _get_state() exactly
    // ---------------------------------------------------------------------------
    func featureVector() -> [Float] {
        var f = [Float]()
        f.reserveCapacity(STATE_SIZE)

        // [0-4] Global stats
        f.append(Float(infectedPct / 100.0))
        f.append(Float(deadPct / 100.0))
        f.append(Float(cureProgress / 100.0))
        f.append(Float(min(1.0, dnaPoints / 100.0)))
        f.append(Float(Double(turn) / Double(MAX_TURNS)))

        // [5-16] Per-region infected %
        for pct in regionInfected {
            f.append(Float(pct / 100.0))
        }

        // [17-19] Disease parameters
        f.append(Float(min(1.0, infectivity / 0.5)))
        f.append(Float(min(1.0, lethality / 0.1)))
        f.append(Float(max(-1.0, min(1.0, visibility))))

        // [20-43] Upgrade flags (actions 1-24)
        for i in 1..<ACTION_SIZE {
            f.append(upgrades[i] ? 1.0 : 0.0)
        }

        // [44] Detected flag
        f.append(isDetected ? 1.0 : 0.0)

        assert(f.count == STATE_SIZE, "Feature vector size mismatch: \(f.count)")
        return f
    }

    // ---------------------------------------------------------------------------
    // Which actions are currently valid (affordable + prereqs met + not owned)
    // ---------------------------------------------------------------------------
    func validActions() -> [Int] {
        (0..<ACTION_SIZE).filter { i in
            if i == 0 { return true }
            if upgrades[i] { return false }
            let a = ALL_ACTIONS[i]
            if dnaPoints < Double(a.cost) { return false }
            return a.prerequisites.allSatisfy { upgrades[$0] }
        }
    }
}
