"""
Export the trained PyTorch DQN model to Core ML (.mlpackage) for iPhone.

Requirements:
    pip install coremltools torch

Usage:
    python export_coreml.py
    python export_coreml.py --model models/plague_ai_ep2000.pt
    python export_coreml.py --output ../ios/PlagueAI.mlpackage

The exported model is then added to the Xcode project.
See ios/README.md for full integration instructions.
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch

# Local imports
from plague_sim import STATE_SIZE, ACTION_SIZE, ACTION_NAMES, ACTIONS
from model import DQN

DEFAULT_MODEL = "models/plague_ai_final.pt"
DEFAULT_OUTPUT = "../ios/PlagueAI.mlpackage"


def export(model_path: str = DEFAULT_MODEL, output_path: str = DEFAULT_OUTPUT) -> None:
    try:
        import coremltools as ct
    except ImportError:
        print("ERROR: coremltools not installed.")
        print("  pip install coremltools")
        sys.exit(1)

    model_path = Path(model_path)
    if not model_path.exists():
        print(f"ERROR: Model file not found: {model_path}")
        print("  Run `python train.py` first to train the model.")
        sys.exit(1)

    print(f"Loading model from {model_path} ...")
    net = DQN(STATE_SIZE, ACTION_SIZE)
    net.load_state_dict(torch.load(str(model_path), map_location="cpu"))
    net.eval()

    # TorchScript trace
    example_input = torch.zeros(1, STATE_SIZE)
    with torch.no_grad():
        traced = torch.jit.trace(net, example_input)
    print("TorchScript trace complete.")

    # Convert to Core ML
    print("Converting to Core ML ...")
    mlmodel = ct.convert(
        traced,
        inputs=[
            ct.TensorType(
                name="game_state",
                shape=(1, STATE_SIZE),
                dtype=float,
            )
        ],
        outputs=[
            ct.TensorType(name="q_values")
        ],
        minimum_deployment_target=ct.target.iOS16,
        compute_precision=ct.precision.FLOAT32,
    )

    # Metadata
    mlmodel.short_description = "Plague Inc. AI advisor — recommends the optimal upgrade action"
    mlmodel.input_description["game_state"] = (
        f"Normalized game state vector: {STATE_SIZE} floats. "
        "See GameState.swift featureVector() for encoding details."
    )
    mlmodel.output_description["q_values"] = (
        f"Estimated Q-values for {ACTION_SIZE} actions. "
        "argmax gives the recommended action index."
    )

    # Embed action metadata so the iOS app can read labels without hard-coding them
    action_labels = [a["name"] for a in ACTIONS]
    action_costs  = [a["cost"]  for a in ACTIONS]
    mlmodel.user_defined_metadata["action_names"] = json.dumps(action_labels)
    mlmodel.user_defined_metadata["action_costs"] = json.dumps(action_costs)
    mlmodel.user_defined_metadata["state_size"]   = str(STATE_SIZE)
    mlmodel.user_defined_metadata["action_size"]  = str(ACTION_SIZE)

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    mlmodel.save(str(out))

    print(f"\nExport successful!")
    print(f"  Output  : {out}")
    print(f"  Input   : game_state  ({STATE_SIZE} × float32)")
    print(f"  Output  : q_values    ({ACTION_SIZE} × float32)")
    print()
    print("Actions (index → name → DNA cost):")
    for i, a in enumerate(ACTIONS):
        print(f"  {i:2d}  {a['name']:<25}  cost={a['cost']}")
    print()
    print("Next step: add PlagueAI.mlpackage to your Xcode project.")
    print("See ios/README.md for complete setup instructions.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Export DQN model to Core ML")
    parser.add_argument("--model",  default=DEFAULT_MODEL,
                        help=f"Trained PyTorch weights (default: {DEFAULT_MODEL})")
    parser.add_argument("--output", default=DEFAULT_OUTPUT,
                        help=f"Output .mlpackage path (default: {DEFAULT_OUTPUT})")
    args = parser.parse_args()
    export(args.model, args.output)
