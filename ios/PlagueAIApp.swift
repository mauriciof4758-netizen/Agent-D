// PlagueAIApp.swift
// Entry point for the Plague Inc. AI Advisor app.
//
// Build steps:
//   1. Train the model:   cd plague_ai && python train.py
//   2. Export Core ML:    python export_coreml.py
//   3. Drag PlagueAI.mlpackage into this Xcode project
//   4. Build & run on iPhone (iOS 16+)

import SwiftUI

@main
struct PlagueAIApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
