"""Activation: the shared fixtures, two hand-checked cases and base-level activation."""
from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cortex_kg import activation  # noqa: E402

FIXTURES = sorted((Path(__file__).parent / "fixtures" / "activation").glob("*.json"))


def run_case(case):
    adj = activation.adjacency_from_graph(case["graph"], case["weights"])
    return activation.spread(adj, case["fired"], case["weights"], case["params"])


def test_fixture_count():
    assert 3 <= len(FIXTURES) <= 5


@pytest.mark.parametrize("path", FIXTURES, ids=lambda p: p.stem)
def test_fixture_matches_to_six_places(path):
    case = json.loads(path.read_text(encoding="utf-8"))
    got = run_case(case)
    assert [(r["id"], r["hop"], r["via"]) for r in got] == [(r["id"], r["hop"], r["via"]) for r in case["expected"]]
    for g, e in zip(got, case["expected"]):
        assert round(g["a"], 6) == round(e["a"], 6)


def test_hand_checked_chain():
    case = json.loads((Path(__file__).parent / "fixtures" / "activation" / "chain.json").read_text(encoding="utf-8"))
    got = {r["id"]: r for r in run_case(case)}
    # route to task: 1.0 * 0.95 * 0.6 / sqrt(1) = 0.57
    assert got["task:deck"]["a"] == pytest.approx(0.57, abs=1e-9)
    # task to agent: 0.57 * 0.8 * 0.6 / sqrt(2), because the task has 2 entries (the route and the agent)
    assert got["agent:checker"]["a"] == pytest.approx(0.57 * 0.8 * 0.6 / math.sqrt(2), abs=1e-9)
    assert got["agent:checker"]["via"] == "task:deck" and got["agent:checker"]["hop"] == 2
    assert got["route:decks"]["hop"] == 0  # the back-spread to the route (0.121) is below its own 1.0


def test_hand_checked_repeated_seed_and_threshold():
    case = json.loads((Path(__file__).parent / "fixtures" / "activation"
                       / "repeated_seed_and_threshold.json").read_text(encoding="utf-8"))
    got = {r["id"]: r for r in run_case(case)}
    assert got["a:1"]["a"] == 1.0  # the larger of 0.4 and 1.0
    # a has 2 entries: 1.0 * 0.3 * 0.6 / sqrt(2) = 0.12728
    assert got["b:1"]["a"] == pytest.approx(0.3 * 0.6 / math.sqrt(2), abs=1e-9)
    assert got["c:1"]["a"] == pytest.approx(0.3 * 0.6 / math.sqrt(2), abs=1e-9) and got["c:1"]["hop"] == 1


def test_threshold_and_hop_limit():
    adj = {"a": [("b", 0.1)], "b": [("a", 0.1)]}
    out = activation.spread(adj, [("a", 1.0)], {}, {})
    assert [r["id"] for r in out] == ["a", "b"]  # 1.0 * 0.1 * 0.6 = 0.06 is above 0.05
    assert activation.spread(adj, [("a", 0.5)], {}, {}) == [{"id": "a", "a": 0.5, "hop": 0, "via": None}]  # 0.03
    chain = {"a": [("b", 1.0)], "b": [("c", 1.0)], "c": [("d", 1.0)]}
    ids = [r["id"] for r in activation.spread(chain, [("a", 1.0)], {}, {"threshold": 0.01})]
    assert ids == ["a", "b", "c"]  # 2 hops by default, so d is not reached


def test_adjacency_degree_and_unknown_relation():
    g = {"edges": [{"s": "x", "r": "triggers", "t": "y"}, {"s": "x", "r": "nope", "t": "z"}]}
    w = {"triggers": {"weight": 0.9, "reverse_weight": 0.2}}
    adj = activation.adjacency_from_graph(g, w)
    assert adj == {"x": [("y", 0.9)], "y": [("x", 0.2)]}


def test_base_level():
    now = datetime(2026, 10, 5, tzinfo=timezone.utc)
    assert activation.base_level([], now) is None
    ts = [now - timedelta(days=1), now - timedelta(days=4)]
    assert activation.base_level(ts, now) == pytest.approx(math.log(1 + 0.5))
    # a use in the future or just now is held at the floor age of 0.01 days
    assert activation.base_level([now], now) == pytest.approx(math.log(0.01 ** -0.5))
    assert activation.base_level(["2026-10-04T00:00:00Z"], "2026-10-05T00:00:00Z") == pytest.approx(0.0)
