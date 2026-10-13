"""The signed bundle: the instruction versions in force of one agent, as files that the agent loads and a signature.

`bundle build` writes <out>/<agent>-<YYYYMMDD-HHMMSS>/ with the text of each version in force (texts/<version-slug>.md),
bundle.json and bundle.sig. bundle.sig is the HMAC-SHA256 of the canonical JSON of bundle.json under the key of the
configuration (bundle_key, a key file) or of --key. `bundle verify` calls verifier.py, which has no dependency on the
rest of the package so that a bank can copy it into its agent start up. Ranviera does not push the bundle to the agent.

A version whose text no longer matches its approved hash is refused, because the bundle would carry text that nobody
approved. Commands: bundle build --agent A [--key FILE] [--out DIR], bundle verify DIR [--key FILE]. Exit 0 on success, 1
where verify fails, and 2 on a refused or invalid request.
"""
from __future__ import annotations

import json
import os
from datetime import date, datetime, timezone
from pathlib import Path

from . import instructions as instr
from . import verifier
from .config import Config
from .fileio import write_atomic


class BundleError(ValueError):
    """A refused request. The message is one sentence that names the reason."""


def key_path(cfg: Config, given: str | None = None) -> Path | None:
    v = given or os.environ.get("CORTEX_BUNDLE_KEY") or (cfg.raw or {}).get("bundle_key")
    return Path(os.path.expanduser(str(v))) if v and str(v).strip() else None


def read_key(cfg: Config, given: str | None = None) -> bytes:
    p = key_path(cfg, given)
    if p is None:
        raise BundleError("No signing key is set. Give --key or set the key bundle_key.")
    try:
        key = p.read_bytes().strip()
    except OSError as exc:
        raise BundleError(f"The key file cannot be read: {exc}") from None
    if not key:
        raise BundleError("The key file is empty.")
    return key


def build(cfg: Config, agent: str, key: bytes, out_dir: str | Path | None = None, now: datetime | None = None,
          today: str | None = None) -> Path:
    st = now or datetime.now(timezone.utc)
    day = today or date.today().isoformat()
    data = instr.load(cfg.profile_dir, agent)
    chosen = []
    for ins in data["instructions"]:
        for v in ins["versions"]:
            if instr.in_force(v, day):
                chosen.append((ins, v))
    if not chosen:
        raise BundleError(f"The agent {agent} has no instruction version in force, so there is nothing to bundle.")
    folder = Path(out_dir or cfg.data_dir / "bundles") / f"{instr.agent_slug(agent)}-{st.strftime('%Y%m%d-%H%M%S')}"
    if folder.exists():
        raise BundleError(f"The folder {folder.name} exists.")
    base = instr.instructions_dir(cfg.profile_dir) / instr.agent_slug(agent)
    versions, files = [], []
    for ins, v in chosen:
        if not v.get("approved_hash") or v["hash"] != v["approved_hash"]:
            raise BundleError(f"The text of {v['id']} differs from the text that was approved, so it cannot be bundled.")
        rel = f"texts/{base.joinpath(v['text']).name}"
        raw = (base / v["text"]).read_bytes()
        write_atomic_bytes(folder / rel, raw)
        sha = v["hash"].removeprefix("sha256:")
        files.append({"path": rel, "sha256": sha})
        approved_at = next((h["ts"] for h in reversed(v["history"]) if h["action"] == "approve"), None)
        versions.append({"id": v["id"], "file": ins["file"], "path": rel, "hash": v["hash"], "approver": v["approver"],
                         "approved_at": approved_at})
    manifest = {"v": 1, "agent": instr.agent_node(agent), "created": st.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "model_versions": sorted(data.get("approved_models", [])), "versions": versions, "files": files}
    write_atomic(folder / "bundle.json", json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    write_atomic(folder / "bundle.sig", verifier.sign(key, manifest) + "\n")
    return folder


def write_atomic_bytes(path: Path, raw: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)


def main(argv: list[str] | None = None) -> int:
    import argparse
    argv = list(argv or [])
    if argv and argv[0] == "bundle":
        argv = argv[1:]
    ap = argparse.ArgumentParser(prog="bundle")
    ap.add_argument("--config")
    ap.add_argument("--json", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--agent", required=True)
    b.add_argument("--key")
    b.add_argument("--out")
    v = sub.add_parser("verify")
    v.add_argument("dir")
    v.add_argument("--key")
    for p in (b, v):
        p.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
        p.add_argument("--config", default=argparse.SUPPRESS)
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return 2
    from .config import load_config
    cfg = load_config(a.config)
    try:
        key = read_key(cfg, a.key)
        if a.cmd == "build":
            folder = build(cfg, a.agent, key, a.out)
            res = {"path": str(folder), "files": sorted(p.relative_to(folder).as_posix() for p in folder.rglob("*")
                                                         if p.is_file())}
            print(json.dumps(res, indent=2) if a.json else f"Wrote the bundle {folder}.")
            return 0
        res = verifier.verify(a.dir, key)
    except (BundleError, instr.InstructionError, OSError, ValueError) as exc:
        print(f"The request was refused: {exc}")
        return 2
    if a.json:
        print(json.dumps(res, indent=2))
    elif res["ok"]:
        print(f"The bundle is sound: {len(res['files'])} instruction file(s) may be loaded.")
    else:
        print("The bundle failed verification.")
        for p in res["problems"]:
            print(f"  {p}")
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    import sys
    sys.exit(main(sys.argv[1:]))
