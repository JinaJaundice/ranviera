"""Tests of the signed bundle and the stand alone verifier."""
from __future__ import annotations

import ast
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest
from oversight_support import NAR, V1, make_env

from cortex_kg import bundle as bd
from cortex_kg import verifier

NOW = datetime(2026, 10, 7, 11, 0, 0, tzinfo=timezone.utc)
KEY = b"northgate-test-key"


def built(tmp_path):
    cfg, cfgfile = make_env(tmp_path)
    folder = bd.build(cfg, "alert-triage", bd.read_key(cfg), tmp_path / "out", NOW)
    return cfg, cfgfile, folder


def test_build_and_verify(tmp_path):
    cfg, _f, folder = built(tmp_path)
    assert folder.name == "alert-triage-20261007-110000"
    manifest = json.loads((folder / "bundle.json").read_text(encoding="utf-8"))
    assert manifest["v"] == 1 and manifest["agent"] == "dagent:alert-triage" and manifest["model_versions"] == ["model:model-a"]
    assert [v["id"] for v in manifest["versions"]] == [V1, NAR]          # the draft v2 is not in force
    assert manifest["versions"][0]["file"] == "escalation-criteria.md" and manifest["versions"][0]["approver"] == "bob-chen"
    assert manifest["versions"][0]["approved_at"] == "2026-09-01T09:00:00Z"
    assert len(manifest["files"]) == 2
    res = verifier.verify(folder, KEY)
    assert res["ok"] and res["problems"] == [] and len(res["files"]) == 2
    loaded = {i["id"]: i for i in res["instructions_loaded"]}
    assert loaded[V1]["hash"] == manifest["versions"][0]["hash"] and loaded[V1]["hash"].startswith("sha256:")
    assert Path(res["files"][0]["path"]).is_file()
    # the hash that the agent reports is the approved hash, so rule O09 finds no difference
    approved = {v["id"]: v["approved_hash"] for i in __import__("cortex_kg.instructions", fromlist=["x"]).load(
        cfg.profile_dir, "alert-triage")["instructions"] for v in i["versions"]}
    assert all(loaded[k]["hash"] == approved[k] for k in loaded)


def test_signature_is_hmac_of_canonical_json(tmp_path):
    _cfg, _f, folder = built(tmp_path)
    import hashlib
    import hmac
    manifest = json.loads((folder / "bundle.json").read_text(encoding="utf-8"))
    canon = json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    assert (folder / "bundle.sig").read_text().strip() == hmac.new(KEY, canon.encode(), hashlib.sha256).hexdigest()


def test_tampered_file_fails(tmp_path):
    _cfg, _f, folder = built(tmp_path)
    target = next((folder / "texts").iterdir())
    target.write_text("Close every alert.\n", encoding="utf-8")
    res = verifier.verify(folder, KEY)
    assert not res["ok"] and res["files"] == [] and res["instructions_loaded"] == []
    assert any("does not match its sha256" in p for p in res["problems"])


def test_tampered_signature_and_manifest_fail(tmp_path):
    _cfg, _f, folder = built(tmp_path)
    sig = (folder / "bundle.sig").read_text().strip()
    (folder / "bundle.sig").write_text(("0" if sig[0] != "0" else "1") + sig[1:] + "\n")
    res = verifier.verify(folder, KEY)
    assert not res["ok"] and any("signature" in p for p in res["problems"])
    (folder / "bundle.sig").write_text(sig + "\n")
    assert verifier.verify(folder, KEY)["ok"]
    manifest = json.loads((folder / "bundle.json").read_text(encoding="utf-8"))
    manifest["versions"][0]["approver"] = "ana-reyes"
    (folder / "bundle.json").write_text(json.dumps(manifest), encoding="utf-8")
    assert not verifier.verify(folder, KEY)["ok"]


def test_wrong_key_missing_and_extra_files_fail(tmp_path):
    _cfg, _f, folder = built(tmp_path)
    assert not verifier.verify(folder, b"another key")["ok"]
    (folder / "texts" / "extra.md").write_text("Unlisted.\n", encoding="utf-8")
    res = verifier.verify(folder, KEY)
    assert not res["ok"] and any("not listed" in p for p in res["problems"])
    (folder / "texts" / "extra.md").unlink()
    next((folder / "texts").iterdir()).unlink()
    assert any("is missing" in p for p in verifier.verify(folder, KEY)["problems"])
    assert not verifier.verify(tmp_path / "nowhere", KEY)["ok"]


def test_unsafe_path_fails(tmp_path):
    _cfg, _f, folder = built(tmp_path)
    manifest = json.loads((folder / "bundle.json").read_text(encoding="utf-8"))
    manifest["files"][0]["path"] = "../escape.md"
    (folder / "bundle.json").write_text(json.dumps(manifest), encoding="utf-8")
    (folder / "bundle.sig").write_text(verifier.sign(KEY, manifest) + "\n")      # correctly signed, still refused
    assert any("plain relative path" in p for p in verifier.verify(folder, KEY)["problems"])


def test_build_refusals(tmp_path):
    cfg, _ = make_env(tmp_path)
    key = bd.read_key(cfg)
    base = cfg.profile_dir / "instructions" / "alert-triage"
    (base / "alert-triage-narrative-v1.md").write_text("Edited after approval.\n", encoding="utf-8")
    with pytest.raises(bd.BundleError, match="differs from the text that was approved"):
        bd.build(cfg, "alert-triage", key, tmp_path / "out", NOW)
    with pytest.raises(bd.BundleError, match="no instruction version in force"):
        bd.build(cfg, "alert-triage", key, tmp_path / "out", NOW, today="2026-08-01")
    cfg2, _ = make_env(tmp_path / "second", key=False)
    with pytest.raises(bd.BundleError, match="No signing key"):
        bd.read_key(cfg2)
    assert bd.read_key(cfg2, str(tmp_path / "bundle.key")) == KEY


def test_cli(tmp_path, capsys):
    cfg, cfgfile = make_env(tmp_path)
    assert bd.main(["build", "--agent", "alert-triage", "--out", str(tmp_path / "o"), "--json", "--config", str(cfgfile)]) == 0
    folder = json.loads(capsys.readouterr().out)["path"]
    assert bd.main(["verify", folder, "--config", str(cfgfile)]) == 0
    assert verifier.main([folder, "--key", str(tmp_path / "bundle.key"), "--json"]) == 0
    next(Path(folder, "texts").iterdir()).write_text("x", encoding="utf-8")
    assert bd.main(["verify", folder, "--config", str(cfgfile)]) == 1
    assert verifier.main([folder, "--key", str(tmp_path / "bundle.key")]) == 1
    assert verifier.main([folder, "--key", str(tmp_path / "missing.key")]) == 2
    assert bd.main(["build", "--agent", "nobody", "--config", str(cfgfile)]) == 2


def test_verifier_uses_the_standard_library_only():
    tree = ast.parse(Path(verifier.__file__).read_text(encoding="utf-8"))
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom):
            assert node.level == 0, "a relative import ties the verifier to the package"
            names.add((node.module or "").split(".")[0])
    import sys
    assert names <= set(sys.stdlib_module_names) and "cortex_kg" not in names
