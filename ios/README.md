# Plague Inc. AI — iPhone Setup Guide

A neural network AI advisor that tells you the optimal action to take in Plague Inc., running entirely on-device via Core ML and Apple's Neural Engine.

---

## Architecture

```
plague_ai/
  plague_sim.py        Simplified Plague Inc. simulation (12 regions, 25 actions)
  model.py             DQN neural network (45 inputs → 128 → 128 → 64 → 25 Q-values)
  train.py             Deep Q-Network training with experience replay
  export_coreml.py     Convert trained PyTorch model → Core ML (.mlpackage)
  demo.py              Watch the AI play a game in your terminal

ios/
  PlagueAIApp.swift    App entry point (@main)
  GameState.swift      Game state data model + 45-feature vector encoding
  PlagueAIModel.swift  Core ML wrapper + rule-based fallback heuristic
  ContentView.swift    SwiftUI UI (two tabs: input game state / view advice)
```

---

## Step 1 — Train the neural network (Mac/Linux/Windows)

```bash
# Install dependencies
pip install torch numpy coremltools

# Train (takes ~10-20 min on CPU, faster on GPU/MPS)
cd plague_ai
python train.py

# Optional: watch a demo of the trained agent
python demo.py --model models/plague_ai_final.pt

# Export to Core ML
python export_coreml.py
# → writes ../ios/PlagueAI.mlpackage
```

Training flags:
```bash
python train.py --episodes 5000    # longer training = better AI
python train.py --resume models/plague_ai_ep2000.pt   # resume a checkpoint
```

---

## Step 2 — Create the Xcode project

1. Open Xcode → **File → New → Project → App**
2. Set:
   - Product Name: `PlagueAdvisor`
   - Interface: SwiftUI
   - Minimum Deployments: **iOS 16.0**
3. Delete the default `ContentView.swift`
4. Drag all `.swift` files from the `ios/` folder into the project navigator

---

## Step 3 — Add the Core ML model

1. Drag `ios/PlagueAI.mlpackage` into the Xcode project navigator
2. In the dialog that appears, check **"Copy items if needed"**
3. Xcode will auto-generate a `PlagueAI` Swift class from the model

> **No model yet?**  
> The app works immediately with a built-in rule-based heuristic even without the trained model. Train it when ready and re-add the `.mlpackage`.

---

## Step 4 — Add the Charts framework

The advice tab uses Swift Charts (included in iOS 16+). No extra frameworks needed.

---

## Step 5 — Build & run

- Connect your iPhone (or use the iOS Simulator)
- Select your device in Xcode's toolbar
- Press **⌘R** to build and run

---

## How to use the app

1. **Game State tab**: Enter your current Plague Inc. statistics
   - Global infected %, dead %, cure progress, DNA points, turn number
   - Per-region infection percentages
   - Toggle on any upgrades you have already purchased
2. Tap **"Get AI Recommendation"**
3. **AI Advice tab** shows:
   - The recommended next action to take in the game
   - Confidence percentage
   - Reasoning explanation
   - Bar chart of Q-values for top valid actions
   - Top 5 alternatives

---

## How the AI works

The neural network is a **Deep Q-Network (DQN)** trained with reinforcement learning:

- **State**: 45 normalized features (infection rates, cure progress, upgrades owned, etc.)
- **Actions**: 25 discrete choices (Wait / 24 upgrades)
- **Reward**: +spread delta × 15, −cure delta × 8, +100 for winning, −20 for losing
- **Training**: ~3000 episodes against the simulated world, epsilon-greedy exploration
- **Inference**: runs on iPhone via Core ML + Apple Neural Engine in <1ms

The model learns strategies like:
- Spread silently before detection (avoid visible symptoms early)
- Prioritize warm/cold resistances to reach all regions
- Use Drug Resistance when cure accelerates
- Save Genetic Re-shuffle for when cure > 50%

---

## Requirements

| Component | Version |
|-----------|---------|
| Python    | 3.11+   |
| PyTorch   | 2.0+    |
| coremltools | 7.0+ |
| Xcode     | 15+     |
| iOS       | 16+     |

---

## Project structure notes

- The feature vector encoding in `GameState.swift` (`featureVector()`) **must exactly match** `_get_state()` in `plague_sim.py`. If you modify the state space, update both files.
- `PlagueAIModel.swift` automatically falls back to the rule-based heuristic if the `.mlpackage` is not found in the bundle — so the app always works.
