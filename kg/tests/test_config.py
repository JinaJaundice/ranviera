import json
from cortex_kg import config


def test_a_windows_path_normalises_the_same_on_any_platform(monkeypatch):
    raw = r"C:\Users\jdoe\.claude\rules\..\rules\decks.md"
    monkeypatch.setattr(config.os, "name", "posix")
    assert config.norm_path(raw) == "c:/users/jdoe/.claude/rules/decks.md"


def test_the_profile_alone_decides_once_it_holds_its_own_content(tmp_path, monkeypatch):
    """The starting content only seeds a new profile, so an update of the product never changes a person's graph."""
    from cortex_kg import config as config_mod
    onto = tmp_path / "ontology"
    (onto / "defaults" / "vocab").mkdir(parents=True)
    (onto / "defaults" / "vocab" / "start.json").write_text("{}", encoding="utf-8")
    (onto / "defaults" / "tasktypes.json").write_text("{}", encoding="utf-8")
    profile = tmp_path / "profile"
    cfg_file = tmp_path / "c.json"
    cfg_file.write_text(json.dumps({"data_dir": str(tmp_path / "data"), "profile_dir": str(profile)}), encoding="utf-8")
    monkeypatch.setenv("CORTEX_ONTOLOGY", str(onto))
    cfg = config_mod.load_config(str(cfg_file))
    assert [p.name for p, _ in config_mod.vocab_files(cfg)] == ["start.json"]
    assert config_mod.tasktype_files(cfg) == [onto / "defaults" / "tasktypes.json"]
    (profile / "vocab").mkdir(parents=True)
    (profile / "vocab" / "mine.json").write_text("{}", encoding="utf-8")
    (profile / "tasktypes.json").write_text("{}", encoding="utf-8")
    assert [p.name for p, _ in config_mod.vocab_files(cfg)] == ["mine.json"]
    assert config_mod.tasktype_files(cfg) == [profile / "tasktypes.json"]
