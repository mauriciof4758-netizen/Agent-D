"""
Simplified Plague Inc. simulation environment for reinforcement learning training.

State vector (STATE_SIZE = 45 features):
  [0]     total_infected_pct
  [1]     total_dead_pct
  [2]     cure_progress
  [3]     dna_points / 100.0 (capped at 1.0)
  [4]     turn / MAX_TURNS
  [5-16]  per-region infected % (12 regions)
  [17]    infectivity / 0.5
  [18]    lethality / 0.1
  [19]    visibility / 1.0
  [20-43] upgrades[1..24] as 0/1 flags
  [44]    is_detected (global)

Action space (ACTION_SIZE = 25):
  0  = Wait
  1  = Air Transmission 1   (cost 3)
  2  = Air Transmission 2   (cost 5,  requires 1)
  3  = Water Transmission 1 (cost 3)
  4  = Water Transmission 2 (cost 5,  requires 3)
  5  = Drug Resistance 1    (cost 6)
  6  = Drug Resistance 2    (cost 15, requires 5)
  7  = Cold Resistance 1    (cost 5)
  8  = Cold Resistance 2    (cost 10, requires 7)
  9  = Heat Resistance 1    (cost 5)
  10 = Heat Resistance 2    (cost 10, requires 9)
  11 = Coughing             (cost 3)
  12 = Sneezing             (cost 2)
  13 = Rash                 (cost 2)
  14 = Sweating             (cost 2)
  15 = Vomiting             (cost 4)
  16 = Fever                (cost 3)
  17 = Pneumonia            (cost 8,  requires 11)
  18 = Pulmonary Edema      (cost 15, requires 17)
  19 = Total Organ Failure  (cost 20, requires 18)
  20 = Hemorrhagic Shock    (cost 25, requires 19)
  21 = Genetic Hardening 1  (cost 10)
  22 = Genetic Hardening 2  (cost 15, requires 21)
  23 = Genetic Re-shuffle   (cost 16, resets cure -25%)
  24 = Symptom Suppression  (cost 12)
"""

import math
import copy
import numpy as np
from dataclasses import dataclass, field
from typing import List, Tuple, Dict, Optional

STATE_SIZE = 45
ACTION_SIZE = 25
MAX_TURNS = 500

# ---------------------------------------------------------------------------
# Action definitions
# ---------------------------------------------------------------------------
# Each entry: name, dna_cost, prerequisites (action indices), effect deltas
ACTIONS: List[Dict] = [
    {"name": "Wait",                 "cost": 0,  "prereq": [],    "inf": 0.00,  "leth": 0.000, "vis": 0.00,  "cure_slow": 0.00},
    {"name": "Air Trans. 1",         "cost": 3,  "prereq": [],    "inf": 0.15,  "leth": 0.000, "vis": 0.00,  "cure_slow": 0.00},
    {"name": "Air Trans. 2",         "cost": 5,  "prereq": [1],   "inf": 0.15,  "leth": 0.000, "vis": 0.00,  "cure_slow": 0.00},
    {"name": "Water Trans. 1",       "cost": 3,  "prereq": [],    "inf": 0.15,  "leth": 0.000, "vis": 0.00,  "cure_slow": 0.00},
    {"name": "Water Trans. 2",       "cost": 5,  "prereq": [3],   "inf": 0.15,  "leth": 0.000, "vis": 0.00,  "cure_slow": 0.00},
    {"name": "Drug Resistance 1",    "cost": 6,  "prereq": [],    "inf": 0.00,  "leth": 0.000, "vis": 0.00,  "cure_slow": 0.20},
    {"name": "Drug Resistance 2",    "cost": 15, "prereq": [5],   "inf": 0.00,  "leth": 0.000, "vis": 0.00,  "cure_slow": 0.30},
    {"name": "Cold Resistance 1",    "cost": 5,  "prereq": [],    "inf": 0.10,  "leth": 0.000, "vis": 0.00,  "cure_slow": 0.00},
    {"name": "Cold Resistance 2",    "cost": 10, "prereq": [7],   "inf": 0.10,  "leth": 0.000, "vis": 0.00,  "cure_slow": 0.00},
    {"name": "Heat Resistance 1",    "cost": 5,  "prereq": [],    "inf": 0.10,  "leth": 0.000, "vis": 0.00,  "cure_slow": 0.00},
    {"name": "Heat Resistance 2",    "cost": 10, "prereq": [9],   "inf": 0.10,  "leth": 0.000, "vis": 0.00,  "cure_slow": 0.00},
    {"name": "Coughing",             "cost": 3,  "prereq": [],    "inf": 0.10,  "leth": 0.002, "vis": 0.05,  "cure_slow": 0.00},
    {"name": "Sneezing",             "cost": 2,  "prereq": [],    "inf": 0.08,  "leth": 0.000, "vis": 0.03,  "cure_slow": 0.00},
    {"name": "Rash",                 "cost": 2,  "prereq": [],    "inf": 0.05,  "leth": 0.001, "vis": 0.04,  "cure_slow": 0.00},
    {"name": "Sweating",             "cost": 2,  "prereq": [],    "inf": 0.03,  "leth": 0.000, "vis": 0.02,  "cure_slow": 0.00},
    {"name": "Vomiting",             "cost": 4,  "prereq": [],    "inf": 0.12,  "leth": 0.003, "vis": 0.08,  "cure_slow": 0.00},
    {"name": "Fever",                "cost": 3,  "prereq": [],    "inf": 0.05,  "leth": 0.002, "vis": 0.10,  "cure_slow": 0.00},
    {"name": "Pneumonia",            "cost": 8,  "prereq": [11],  "inf": 0.15,  "leth": 0.010, "vis": 0.15,  "cure_slow": 0.00},
    {"name": "Pulmonary Edema",      "cost": 15, "prereq": [17],  "inf": 0.05,  "leth": 0.020, "vis": 0.20,  "cure_slow": 0.00},
    {"name": "Total Organ Failure",  "cost": 20, "prereq": [18],  "inf": 0.00,  "leth": 0.040, "vis": 0.30,  "cure_slow": 0.00},
    {"name": "Hemorrhagic Shock",    "cost": 25, "prereq": [19],  "inf": 0.05,  "leth": 0.030, "vis": 0.25,  "cure_slow": 0.00},
    {"name": "Gen. Hardening 1",     "cost": 10, "prereq": [],    "inf": 0.00,  "leth": 0.000, "vis": 0.00,  "cure_slow": 0.25},
    {"name": "Gen. Hardening 2",     "cost": 15, "prereq": [21],  "inf": 0.00,  "leth": 0.000, "vis": 0.00,  "cure_slow": 0.30},
    {"name": "Gen. Re-shuffle",      "cost": 16, "prereq": [],    "inf": 0.00,  "leth": 0.000, "vis": 0.00,  "cure_slow": 0.00},
    {"name": "Symptom Suppress.",    "cost": 12, "prereq": [],    "inf": 0.00,  "leth": 0.000, "vis": -0.50, "cure_slow": 0.00},
]

ACTION_NAMES = [a["name"] for a in ACTIONS]

# ---------------------------------------------------------------------------
# Region definitions
# ---------------------------------------------------------------------------
@dataclass
class Region:
    name: str
    population: float     # total people
    climate: str          # "hot" | "cold" | "temperate"
    healthcare: float     # 0-10 (10 = best healthcare)
    poverty: float        # 0-10 (10 = most poverty)
    infected: float = 0.0
    dead: float = 0.0
    detected: bool = False

    @property
    def healthy(self) -> float:
        return max(0.0, self.population - self.infected - self.dead)

    @property
    def infected_pct(self) -> float:
        return self.infected / self.population if self.population > 0 else 0.0


_REGIONS_TEMPLATE: List[Region] = [
    Region("N. America",   500_000_000,  "temperate", 8.5, 3.0),
    Region("Europe",       750_000_000,  "cold",      9.0, 2.0),
    Region("S. America",   420_000_000,  "hot",       5.0, 6.0),
    Region("Africa",     1_300_000_000,  "hot",       3.0, 8.5),
    Region("Middle East",  400_000_000,  "hot",       6.0, 5.0),
    Region("India",      1_400_000_000,  "hot",       4.0, 7.0),
    Region("China",      1_400_000_000,  "temperate", 7.0, 4.0),
    Region("SE Asia",      700_000_000,  "hot",       5.0, 6.0),
    Region("Russia",       144_000_000,  "cold",      6.0, 5.0),
    Region("Oceania",       45_000_000,  "hot",       8.5, 2.5),
    Region("C. Asia",      100_000_000,  "cold",      4.0, 7.0),
    Region("Islands",      100_000_000,  "hot",       4.5, 5.5),
]
NUM_REGIONS = len(_REGIONS_TEMPLATE)
REGION_NAMES = [r.name for r in _REGIONS_TEMPLATE]


# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
class PlagueEnv:
    """
    Gym-style environment simulating Plague Inc. for DQN training.

    Usage:
        env = PlagueEnv()
        state = env.reset()
        while not env.done:
            action = agent.select(state, env.get_valid_actions())
            state, reward, done, info = env.step(action)
    """

    def __init__(self, seed: Optional[int] = None):
        self._rng = np.random.default_rng(seed)
        self.regions: List[Region] = []
        self.upgrades: List[bool] = []
        self.dna_points: float = 0.0
        self.cure_progress: float = 0.0
        self.turn: int = 0
        self.done: bool = False
        self.won: bool = False
        self._infectivity: float = 0.0
        self._lethality: float = 0.0
        self._visibility: float = 0.0
        self._cure_slow: float = 0.0
        self.reset()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def reset(self) -> np.ndarray:
        """Reset to initial state and return first observation."""
        self.regions = copy.deepcopy(_REGIONS_TEMPLATE)
        self.upgrades = [False] * ACTION_SIZE
        self.dna_points = 5.0
        self.cure_progress = 0.0
        self.turn = 0
        self.done = False
        self.won = False
        self._infectivity = 0.05
        self._lethality = 0.001
        self._visibility = 0.0
        self._cure_slow = 0.0

        # Seed infection: favour warm, poor, dense regions
        start_weights = np.array([1, 1, 3, 5, 3, 5, 3, 4, 1, 1, 2, 2], dtype=float)
        start_weights /= start_weights.sum()
        start_idx = int(self._rng.choice(NUM_REGIONS, p=start_weights))
        self.regions[start_idx].infected = 1_000.0

        return self._get_state()

    def get_valid_actions(self) -> List[int]:
        return [i for i in range(ACTION_SIZE) if self._is_valid(i)]

    def step(self, action: int) -> Tuple[np.ndarray, float, bool, dict]:
        """Advance the simulation by one turn after taking `action`."""
        assert not self.done, "Call reset() before stepping again."

        total_pop = self._total_pop()
        prev_affected = self._total_infected() + self._total_dead()
        prev_cure = self.cure_progress
        reward = 0.0

        # --- Apply upgrade ---------------------------------------------------
        if action != 0:
            if self._is_valid(action):
                a = ACTIONS[action]
                self.dna_points -= a["cost"]
                self.upgrades[action] = True
                self._infectivity += a["inf"]
                self._lethality += a["leth"]
                self._visibility = max(-1.0, self._visibility + a["vis"])
                self._cure_slow += a["cure_slow"]
                if action == 23:  # Genetic Re-shuffle
                    self.cure_progress = max(0.0, self.cure_progress - 0.25)
                reward += 0.1
            else:
                reward -= 0.2  # penalty for invalid/unaffordable action

        # --- Simulate world --------------------------------------------------
        self._spread()
        self._advance_cure()
        self._earn_dna()
        self.turn += 1

        new_affected = self._total_infected() + self._total_dead()
        spread_delta = (new_affected - prev_affected) / total_pop
        cure_delta = self.cure_progress - prev_cure

        reward += spread_delta * 15.0
        reward -= cure_delta * 8.0

        # --- Terminal conditions ---------------------------------------------
        info: Dict = {}
        healthy_pct = self._total_healthy() / total_pop
        dead_pct = self._total_dead() / total_pop
        infected_pct = self._total_infected() / total_pop

        if self.cure_progress >= 1.0:
            self.done, self.won = True, False
            reward -= 20.0
            info["result"] = "cure_complete"
        elif (infected_pct + dead_pct) >= 0.999:
            self.done, self.won = True, True
            reward += 100.0
            info["result"] = "world_eliminated"
        elif healthy_pct < 1e-4:
            self.done, self.won = True, True
            reward += 100.0
            info["result"] = "world_eliminated"
        elif self.turn >= MAX_TURNS:
            self.done, self.won = False, False
            reward -= 10.0
            info["result"] = "timeout"

        return self._get_state(), reward, self.done, info

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------
    def _total_pop(self) -> float:
        return sum(r.population for r in self.regions)

    def _total_infected(self) -> float:
        return sum(r.infected for r in self.regions)

    def _total_dead(self) -> float:
        return sum(r.dead for r in self.regions)

    def _total_healthy(self) -> float:
        return sum(r.healthy for r in self.regions)

    def _is_detected(self) -> bool:
        return any(r.detected for r in self.regions)

    def _climate_mod(self, region: Region) -> float:
        m = 1.0
        if region.climate == "cold":
            m += 0.3 * self.upgrades[7] + 0.3 * self.upgrades[8] - 0.3
        elif region.climate == "hot":
            m += 0.3 * self.upgrades[9] + 0.3 * self.upgrades[10] - 0.1
        return max(0.05, m)

    def _spread(self) -> None:
        total_pop = self._total_pop()
        global_infected_pct = self._total_infected() / total_pop

        for r in self.regions:
            if r.healthy <= 0:
                continue

            # Local spread
            local_rate = r.infected_pct
            if local_rate <= 0 and global_infected_pct < 0.001:
                continue

            climate_m = self._climate_mod(r)
            poverty_m = 1.0 + r.poverty * 0.08
            health_m = max(0.1, 1.0 - r.healthcare * 0.06)

            new_inf = (
                self._infectivity * climate_m * poverty_m * health_m
                * local_rate * r.healthy
            )
            # Cross-border seeding from global pool
            if global_infected_pct > 0.005:
                new_inf += r.healthy * global_infected_pct * 0.0003

            noise = float(self._rng.normal(1.0, 0.12))
            new_inf = max(0.0, new_inf * noise)
            new_inf = min(r.healthy, new_inf)

            r.infected += new_inf

            # Deaths
            health_factor = max(0.1, 1.0 - r.healthcare * 0.07)
            raw_deaths = r.infected * self._lethality * health_factor
            new_dead = min(r.infected * 0.15, max(0.0, raw_deaths))
            r.infected -= new_dead
            r.dead += new_dead

            # Detection
            if not r.detected:
                threshold = max(0.0005, 0.008 - self._visibility * 0.004)
                detect_prob = 0.08 + r.healthcare * 0.025
                if r.infected_pct > threshold and self._rng.random() < detect_prob:
                    r.detected = True

    def _advance_cure(self) -> None:
        if not self._is_detected():
            return
        detected = [r for r in self.regions if r.detected]
        base_speed = sum(r.healthcare / 10.0 for r in detected) * 0.0025
        slow_mult = max(0.05, 1.0 - self._cure_slow)
        dead_penalty = max(0.1, 1.0 - self._total_dead() / self._total_pop() * 0.6)
        self.cure_progress = min(1.0, self.cure_progress + base_speed * slow_mult * dead_penalty)

    def _earn_dna(self) -> None:
        pct = self._total_infected() / self._total_pop()
        gain = math.sqrt(max(0, pct)) * 0.6 + pct * 0.3 + 0.1
        self.dna_points = min(200.0, self.dna_points + gain)

    def _is_valid(self, action: int) -> bool:
        if action == 0:
            return True
        if self.upgrades[action]:
            return False
        a = ACTIONS[action]
        if self.dna_points < a["cost"]:
            return False
        return all(self.upgrades[p] for p in a["prereq"])

    def _get_state(self) -> np.ndarray:
        total_pop = self._total_pop()
        state: List[float] = []

        # Global stats (5)
        state.append(self._total_infected() / total_pop)
        state.append(self._total_dead() / total_pop)
        state.append(self.cure_progress)
        state.append(min(1.0, self.dna_points / 100.0))
        state.append(self.turn / MAX_TURNS)

        # Per-region infected % (12)
        for r in self.regions:
            state.append(r.infected_pct)

        # Disease parameters (3)
        state.append(min(1.0, self._infectivity / 0.5))
        state.append(min(1.0, self._lethality / 0.1))
        state.append(max(-1.0, min(1.0, self._visibility)))

        # Upgrade flags, indices 1-24 (24)
        for i in range(1, ACTION_SIZE):
            state.append(1.0 if self.upgrades[i] else 0.0)

        # Global detected flag (1)
        state.append(1.0 if self._is_detected() else 0.0)

        assert len(state) == STATE_SIZE, f"State size mismatch: {len(state)}"
        return np.array(state, dtype=np.float32)
