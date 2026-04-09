"""
DQN neural network model and experience replay buffer for Plague Inc. AI.

Architecture:
    Input  : STATE_SIZE (45) normalized game state features
    Hidden : 128 → 128 → 64  (ReLU activations)
    Output : ACTION_SIZE (25) Q-values, one per discrete action

Exported to Core ML for on-device inference on iPhone (iOS 16+).
"""

import random
import numpy as np
import torch
import torch.nn as nn
from collections import deque
from typing import Tuple, List

from plague_sim import STATE_SIZE, ACTION_SIZE


class DQN(nn.Module):
    """Deep Q-Network: maps game state → Q-values for each action."""

    def __init__(
        self,
        state_size: int = STATE_SIZE,
        action_size: int = ACTION_SIZE,
    ) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(state_size, 128),
            nn.ReLU(),
            nn.Linear(128, 128),
            nn.ReLU(),
            nn.Linear(128, 64),
            nn.ReLU(),
            nn.Linear(64, action_size),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


class ReplayBuffer:
    """Fixed-size circular buffer storing (s, a, r, s', done) transitions."""

    def __init__(self, capacity: int = 100_000) -> None:
        self._buf: deque = deque(maxlen=capacity)

    def push(
        self,
        state: np.ndarray,
        action: int,
        reward: float,
        next_state: np.ndarray,
        done: float,
    ) -> None:
        self._buf.append((state, action, reward, next_state, done))

    def sample(self, batch_size: int) -> Tuple[torch.Tensor, ...]:
        batch = random.sample(self._buf, batch_size)
        states, actions, rewards, next_states, dones = zip(*batch)
        return (
            torch.FloatTensor(np.array(states)),
            torch.LongTensor(actions),
            torch.FloatTensor(rewards),
            torch.FloatTensor(np.array(next_states)),
            torch.FloatTensor(dones),
        )

    def __len__(self) -> int:
        return len(self._buf)
