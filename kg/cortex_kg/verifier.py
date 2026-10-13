"""The bundle verifier. Copy this single file into the start up of an agent.

It uses the Python standard library only and imports nothing from cortex_kg. `verify(bundle_dir, key_bytes)` checks the
HMAC-SHA256 signature of bundle.json (bundle.sig) over its canonical JSON (sorted keys, the separators , and :), then the
sha256 of every file that bundle.json lists, then the hash of every instruction version against its file. It returns

    { "ok": bool, "files": [...], "instructions_loaded": [...], "problems": [...] }

`files` names the files that the agent may load, and `instructions_loaded` is the list for the opening record of a run
(ranviera.run.v1, payload.instructions_loaded), so that rule O09 can compare the hashes that the agent loaded with the
approved hashes. Where anything fails, both lists are empty and `problems` says why, so that an agent that loads only
what verify returns loads nothing from a bundle that was altered.

Command line: python verifier.py BUNDLE_DIR --key KEY_FILE [--json]. Exit 0 when the bundle is sound, 1 when it is not
and 2 when the request is invalid.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import sys
from pathlib import Path


def canonical(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def sign(key_bytes: bytes, manifest: dict) -> str:
    return hmac.new(key_bytes, canonical(manifest).encode("utf-8"), hashlib.sha256).hexdigest()


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _plain(rel) -> bool:
    if not isinstance(rel, str) or not rel or rel.startswith(("/", "\\")) or ":" in rel:
        return False
    return ".." not in Path(rel.replace("\\", "/")).parts


def verify(bundle_dir, key_bytes: bytes) -> dict:
    root = Path(bundle_dir)
    problems: list[str] = []
    result = {"ok": False, "files": [], "instructions_loaded": [], "problems": problems}
    try:
        manifest = json.loads((root / "bundle.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        problems.append("bundle.json is absent or is not valid JSON.")
        return result
    try:
        sig = (root / "bundle.sig").read_text(encoding="utf-8").strip()
    except OSError:
        sig = ""
        problems.append("bundle.sig is absent.")
    if not isinstance(manifest, dict) or manifest.get("v") != 1:
        problems.append("bundle.json is not version 1.")
        return result
    if sig and not hmac.compare_digest(sig, sign(key_bytes, manifest)):
        problems.append("The signature does not match bundle.json and the key.")
    listed = manifest.get("files") if isinstance(manifest.get("files"), list) else []
    hashes: dict[str, str] = {}
    for f in listed:
        rel = f.get("path") if isinstance(f, dict) else None
        if not _plain(rel):
            problems.append(f"The path {rel!r} in bundle.json is not a plain relative path.")
            continue
        p = root / rel
        if not p.is_file():
            problems.append(f"The file {rel} is missing.")
        elif _sha(p) != f.get("sha256"):
            problems.append(f"The file {rel} does not match its sha256.")
        else:
            hashes[rel] = f["sha256"]
    known = {f.get("path") for f in listed if isinstance(f, dict)} | {"bundle.json", "bundle.sig"}
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root).as_posix()
        if p.is_file() and rel not in known:
            problems.append(f"The file {rel} is in the folder and is not listed in bundle.json.")
    files, loaded = [], []
    for v in manifest.get("versions") if isinstance(manifest.get("versions"), list) else []:
        rel = v.get("path")
        if not _plain(rel) or rel not in hashes:
            problems.append(f"The version {v.get('id')} has no verified file.")
            continue
        want = str(v.get("hash", "")).removeprefix("sha256:")
        if want != hashes[rel]:
            problems.append(f"The hash of the version {v.get('id')} differs from its file.")
            continue
        files.append({"id": v["id"], "file": v.get("file"), "path": str(root / rel), "sha256": hashes[rel]})
        loaded.append({"id": v["id"], "hash": "sha256:" + hashes[rel], "path": v.get("file")})
    if not manifest.get("versions"):
        problems.append("bundle.json lists no instruction version.")
    if problems:
        return result
    result.update(ok=True, files=files, instructions_loaded=loaded)
    return result


def main(argv: list[str] | None = None) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="verifier")
    ap.add_argument("bundle")
    ap.add_argument("--key", required=True)
    ap.add_argument("--json", action="store_true")
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return 2
    try:
        key = Path(a.key).read_bytes().strip()
    except OSError as exc:
        print(f"The key file cannot be read: {exc}")
        return 2
    res = verify(a.bundle, key)
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
    sys.exit(main(sys.argv[1:]))
