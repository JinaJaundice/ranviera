"""Events: the shape, the month routing and the read filters."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cortex_kg import events  # noqa: E402


def cfg_for(tmp_path):
    return SimpleNamespace(events_dir=tmp_path / "events")


def test_make_sets_version_and_timestamp():
    ev = events.make("read", ["rulefile:decks"], "s1", "hook", "Read rules/decks.md", 0.8, "k1", {"tool": "Read"})
    assert ev["v"] == 1
    assert ev["ts"].endswith("Z") and len(ev["ts"]) == 24
    assert ev["nodes"] == ["rulefile:decks"] and ev["key"] == "k1" and ev["meta"] == {"tool": "Read"}
    assert len(events.make("tool", [], "s", "hook", "x" * 300)["label"]) == 120


def test_append_routes_by_month_and_round_trips(tmp_path):
    cfg = cfg_for(tmp_path)
    a = events.make("prompt", ["route:decks"], "s1", "hook", "one")
    a["ts"] = "2026-09-30T23:59:59.999Z"
    b = events.make("prompt", ["route:decks"], "s1", "hook", "two – unicode")
    b["ts"] = "2026-10-01T00:00:00.000Z"
    events.append(cfg, a)
    events.append(cfg, b)
    assert sorted(p.name for p in cfg.events_dir.glob("*.jsonl")) == ["2026-09.jsonl", "2026-10.jsonl"]
    text = (cfg.events_dir / "2026-10.jsonl").read_text(encoding="utf-8")
    assert text.count("\n") == 1 and "–" in text
    assert list(events.read(cfg)) == [a, b]
    assert json.loads(text) == b


def test_read_filters_by_since_and_until(tmp_path):
    from datetime import datetime, timezone
    cfg = cfg_for(tmp_path)
    for i, ts in enumerate(["2026-09-10T10:00:00.000Z", "2026-10-02T10:00:00.000Z", "2026-10-03T10:00:00.000Z"]):
        ev = events.make("read", [], "s", "hook", f"e{i}")
        ev["ts"] = ts
        events.append(cfg, ev)
    got = [e["label"] for e in events.read(cfg, since="2026-10-01T00:00:00Z")]
    assert got == ["e1", "e2"]
    got = [e["label"] for e in events.read(cfg, since=datetime(2026, 9, 1, tzinfo=timezone.utc),
                                           until="2026-10-02T12:00:00Z")]
    assert got == ["e0", "e1"]
    assert list(events.read(SimpleNamespace(events_dir=tmp_path / "none"))) == []


def test_read_skips_schema_invalid_lines_and_counts_them(tmp_path):
    cfg = cfg_for(tmp_path)
    good = events.make("read", ["rulefile:decks"], "s1", "hook", "ok")
    events.append(cfg, good)
    for bad in ({**good, "v": 2}, {**good, "weight": "high"}, {**good, "nodes": ["a", 3]}, {**good, "meta": []},
                {k: v for k, v in good.items() if k != "kind"}, {**good, "ts": "yesterday"}):
        events.append(cfg, bad)
    with (cfg.events_dir / f"{good['ts'][:7]}.jsonl").open("a", encoding="utf-8") as fh:
        fh.write("not json\n[1]\n")
    stats = {}
    assert list(events.read(cfg, stats=stats)) == [good]
    assert stats["invalid"] == 8
    assert list(events.read(cfg)) == [good]
