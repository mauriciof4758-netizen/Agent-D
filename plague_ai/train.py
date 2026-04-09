"""
DQN training script for Plague Inc. AI.

Usage:
    python train.py                       # train with defaults
    python train.py --episodes 5000       # longer training
    python train.py --resume models/plague_ai_ep2000.pt

After training the final model is saved to models/plague_ai_final.pt.
Run export_coreml.py to convert it for iPhone.
"""

import argparse
import math
import os
import random
import time
from pathlib import Path
from typing import Optional

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim

from plague_sim import PlagueEnv, ACTION_SIZE, ACTION_NAMES
from model import DQN, ReplayBuffer

# ---------------------------------------------------------------------------
# Hyper-parameters
# ---------------------------------------------------------------------------
GAMMA = 0.99
LR = 1e-3
BATCH_SIZE = 64
BUFFER_SIZE = 100_000
EPSILON_START = 1.0
EPSILON_END = 0.05
EPSILON_DECAY_EPISODES = 1_500   # linear decay over this many episodes
TARGET_UPDATE_STEPS = 200        # hard-copy policy → target every N steps
SAVE_EVERY = 500                 # checkpoint every N episodes
DEFAULT_EPISODES = 3_000


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def select_action(
    q_net: DQN,
    state: np.ndarray,
    valid_actions: list,
    epsilon: float,
    device: torch.device,
) -> int:
    if random.random() < epsilon:
        return random.choice(valid_actions)
    with torch.no_grad():
        q = q_net(torch.FloatTensor(state).unsqueeze(0).to(device)).squeeze(0)
        # Mask actions that are not valid
        mask = torch.full((ACTION_SIZE,), float("-inf"), device=device)
        for a in valid_actions:
            mask[a] = 0.0
        return int((q + mask).argmax().item())


def compute_loss(
    policy_net: DQN,
    target_net: DQN,
    batch: tuple,
    device: torch.device,
) -> torch.Tensor:
    states, actions, rewards, next_states, dones = [t.to(device) for t in batch]

    q_current = policy_net(states).gather(1, actions.unsqueeze(1)).squeeze(1)

    with torch.no_grad():
        q_next = target_net(next_states).max(1)[0]
        q_target = rewards + GAMMA * q_next * (1.0 - dones)

    return nn.SmoothL1Loss()(q_current, q_target)


# ---------------------------------------------------------------------------
# Main training loop
# ---------------------------------------------------------------------------
def train(
    num_episodes: int = DEFAULT_EPISODES,
    resume: Optional[str] = None,
    verbose: bool = True,
) -> DQN:
    device = torch.device(
        "mps" if torch.backends.mps.is_available()
        else "cuda" if torch.cuda.is_available()
        else "cpu"
    )
    if verbose:
        print(f"Device : {device}")
        print(f"Episodes: {num_episodes}")

    env = PlagueEnv()
    policy_net = DQN().to(device)
    target_net = DQN().to(device)

    start_episode = 0
    if resume and Path(resume).exists():
        policy_net.load_state_dict(torch.load(resume, map_location=device))
        if verbose:
            print(f"Resumed from {resume}")

    target_net.load_state_dict(policy_net.state_dict())
    target_net.eval()

    optimizer = optim.Adam(policy_net.parameters(), lr=LR)
    buffer = ReplayBuffer(BUFFER_SIZE)

    total_steps = 0
    win_count = 0
    episode_rewards: list = []
    t0 = time.time()

    for ep in range(start_episode, num_episodes):
        state = env.reset()
        ep_reward = 0.0
        epsilon = max(
            EPSILON_END,
            EPSILON_START - (ep / EPSILON_DECAY_EPISODES) * (EPSILON_START - EPSILON_END),
        )

        while not env.done:
            valid = env.get_valid_actions()
            action = select_action(policy_net, state, valid, epsilon, device)
            next_state, reward, done, info = env.step(action)
            buffer.push(state, action, reward, next_state, float(done))

            state = next_state
            ep_reward += reward
            total_steps += 1

            # Train one step
            if len(buffer) >= BATCH_SIZE:
                batch = buffer.sample(BATCH_SIZE)
                loss = compute_loss(policy_net, target_net, batch, device)
                optimizer.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(policy_net.parameters(), 1.0)
                optimizer.step()

            # Sync target network
            if total_steps % TARGET_UPDATE_STEPS == 0:
                target_net.load_state_dict(policy_net.state_dict())

        if env.won:
            win_count += 1
        episode_rewards.append(ep_reward)

        # Logging
        if verbose and (ep + 1) % 100 == 0:
            avg_r = np.mean(episode_rewards[-100:])
            elapsed = time.time() - t0
            print(
                f"Ep {ep+1:>5}/{num_episodes} | "
                f"AvgR(100): {avg_r:>8.1f} | "
                f"ε: {epsilon:.3f} | "
                f"WinRate: {win_count/(ep+1):.1%} | "
                f"Steps: {total_steps:,} | "
                f"Buffer: {len(buffer):,} | "
                f"Time: {elapsed:.0f}s"
            )

        # Checkpoint
        if (ep + 1) % SAVE_EVERY == 0:
            Path("models").mkdir(exist_ok=True)
            ckpt = f"models/plague_ai_ep{ep+1}.pt"
            torch.save(policy_net.state_dict(), ckpt)
            if verbose:
                print(f"  Saved checkpoint → {ckpt}")

    # Final save
    Path("models").mkdir(exist_ok=True)
    final_path = "models/plague_ai_final.pt"
    torch.save(policy_net.state_dict(), final_path)
    if verbose:
        print(f"\nTraining complete.")
        print(f"  Final win rate : {win_count/num_episodes:.1%}")
        print(f"  Model saved    : {final_path}")
        print(f"  Total time     : {time.time()-t0:.0f}s")
        print(f"\nNext step: python export_coreml.py")

    return policy_net


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train Plague Inc. DQN agent")
    parser.add_argument("--episodes", type=int, default=DEFAULT_EPISODES,
                        help=f"Number of training episodes (default {DEFAULT_EPISODES})")
    parser.add_argument("--resume", type=str, default=None,
                        help="Path to checkpoint .pt file to resume from")
    parser.add_argument("--quiet", action="store_true",
                        help="Suppress progress output")
    args = parser.parse_args()
    train(num_episodes=args.episodes, resume=args.resume, verbose=not args.quiet)
