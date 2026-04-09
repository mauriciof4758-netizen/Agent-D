"""
Run a trained (or random) Plague Inc. agent and print a play-by-play.

Usage:
    python demo.py                                  # random agent
    python demo.py --model models/plague_ai_final.pt  # trained agent
    python demo.py --model models/plague_ai_final.pt --turns 50
"""

import argparse
import sys
from pathlib import Path

import numpy as np
import torch

from plague_sim import PlagueEnv, ACTION_NAMES, ACTIONS, ACTION_SIZE, STATE_SIZE
from model import DQN


def run_demo(model_path: str | None, max_turns: int, seed: int) -> None:
    env = PlagueEnv(seed=seed)
    device = torch.device("cpu")

    # Load model if provided
    net: DQN | None = None
    if model_path:
        p = Path(model_path)
        if not p.exists():
            print(f"ERROR: {model_path} not found. Run train.py first.")
            sys.exit(1)
        net = DQN(STATE_SIZE, ACTION_SIZE).to(device)
        net.load_state_dict(torch.load(str(p), map_location=device))
        net.eval()
        print(f"Loaded model: {p}\n")
    else:
        print("No model provided — using random valid actions.\n")

    state = env.reset()
    total_pop = sum(r.population for r in env.regions)

    print("=" * 65)
    print("  PLAGUE INC. AI  —  LIVE PLAY-BY-PLAY")
    print("=" * 65)

    turn = 0
    while not env.done and turn < max_turns:
        inf_pct  = env._total_infected() / total_pop * 100
        dead_pct = env._total_dead()     / total_pop * 100
        dna      = env.dna_points
        cure     = env.cure_progress * 100
        valid    = env.get_valid_actions()

        # Choose action
        if net is not None:
            with torch.no_grad():
                q = net(torch.FloatTensor(state).unsqueeze(0)).squeeze(0)
                mask = torch.full((ACTION_SIZE,), float("-inf"))
                for a in valid:
                    mask[a] = 0.0
                action = int((q + mask).argmax().item())
                confidence = float(torch.softmax(q + mask, dim=0).max().item())
        else:
            action = int(np.random.choice(valid))
            confidence = 0.0

        action_name = ACTION_NAMES[action]
        cost = ACTIONS[action]["cost"]

        state, reward, done, info = env.step(action)
        turn += 1

        # Print summary every 5 turns and whenever something interesting happens
        if turn % 5 == 0 or action != 0 or done:
            conf_str = f" ({confidence:.0%})" if net else ""
            action_str = f"WAIT" if action == 0 else f"EVOLVE {action_name} [-{cost} DNA]"
            print(
                f"Turn {turn:>3} | "
                f"Inf: {inf_pct:>5.1f}% | "
                f"Dead: {dead_pct:>5.1f}% | "
                f"Cure: {cure:>5.1f}% | "
                f"DNA: {dna:>5.1f} | "
                f"Action: {action_str}{conf_str}"
            )

    print("=" * 65)
    if env.won:
        inf_pct  = env._total_infected() / total_pop * 100
        dead_pct = env._total_dead()     / total_pop * 100
        print(f"  RESULT : WIN  — World eliminated in {env.turn} turns!")
        print(f"  Infected: {inf_pct:.1f}%  |  Dead: {dead_pct:.1f}%")
    elif env.cure_progress >= 1.0:
        print(f"  RESULT : LOSE — Cure completed at turn {env.turn}.")
    else:
        inf_pct = (env._total_infected() + env._total_dead()) / total_pop * 100
        print(f"  RESULT : TIMEOUT — {inf_pct:.1f}% of world affected after {env.turn} turns.")
    print("=" * 65)

    # Show per-region breakdown
    print("\nRegion breakdown:")
    for r in env.regions:
        bar = "█" * int(r.infected_pct * 20) + "░" * (20 - int(r.infected_pct * 20))
        dead_m = r.dead / 1e6
        det = "✓" if r.detected else " "
        print(f"  [{det}] {r.name:<14} {bar}  {r.infected_pct*100:4.1f}% inf  {dead_m:6.1f}M dead")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Demo the Plague Inc. AI agent")
    parser.add_argument("--model", default=None,
                        help="Path to trained .pt weights (omit for random play)")
    parser.add_argument("--turns", type=int, default=200,
                        help="Max turns to display (default 200)")
    parser.add_argument("--seed",  type=int, default=42,
                        help="Random seed for reproducibility (default 42)")
    args = parser.parse_args()
    run_demo(args.model, args.turns, args.seed)
