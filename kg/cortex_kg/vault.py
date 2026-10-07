"""The encrypted store: the memory folder and the private overlay, sealed with age for the private repository.

The memory holds client pricing and the overlay holds the real values behind the placeholders, so neither may reach
GitHub in the clear. The store packs both into one deterministic tar file and encrypts it with age (the pyrage
library) to the public keys in vault/recipients.txt. Encryption needs only those public keys, so the automatic sync
can seal the store without any secret. Decryption needs the private key (the identity), which is kept on each
machine at <data_dir>/vault/identity.txt and never committed. The owner keeps a copy somewhere safe and copies
it to a new machine once.

Files in the repository:
  vault/recipients.txt   the public keys, one per line (age1...)
  vault/memory.age       the sealed store
  vault/MANIFEST.json    the sha256 of the plain store, its file count, the date and the host it was sealed on

The store is sealed again only when its plain content changes, so an unchanged memory makes no new commit.
"""
from __future__ import annotations

import gzip
import hashlib
import io
import json
import platform
import shutil
import tarfile
from datetime import date, datetime, timezone
from pathlib import Path

from .config import Config

STORE = "memory.age"
MANIFEST = "MANIFEST.json"
RECIPIENTS = "recipients.txt"


def vault_dir(cfg: Config) -> Path:
    return cfg.repo_root / "vault"


def identity_path(cfg: Config) -> Path:
    return cfg.data_dir / "vault" / "identity.txt"


def enabled(cfg: Config) -> bool:
    v = cfg.raw.get("vault") or {}
    return bool(v.get("enabled")) if isinstance(v, dict) else False


def _sources(cfg: Config) -> list[tuple[str, Path]]:
    """(name inside the store, folder) for each folder the store holds."""
    return [("memory", cfg.memory_dir), ("overlay", cfg.overlay_dir)]


def _files(cfg: Config) -> list[tuple[str, Path]]:
    out = []
    for prefix, root in _sources(cfg):
        if not root.is_dir():
            continue
        for f in sorted(p for p in root.rglob("*") if p.is_file()):
            rel = f.relative_to(root).as_posix()
            if "__pycache__" in rel or rel.endswith(".tmp"):
                continue
            out.append((f"{prefix}/{rel}", f))
    return out


def pack(cfg: Config) -> tuple[bytes, int]:
    """The plain store as gzip bytes, built so that the same files always give the same bytes."""
    buf = io.BytesIO()
    files = _files(cfg)
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for name, path in files:
            data = path.read_bytes()
            info = tarfile.TarInfo(name)
            info.size, info.mtime, info.mode, info.uid, info.gid = len(data), 0, 0o644, 0, 0
            tar.addfile(info, io.BytesIO(data))
    gz = io.BytesIO()
    with gzip.GzipFile(fileobj=gz, mode="wb", mtime=0) as z:
        z.write(buf.getvalue())
    return gz.getvalue(), len(files)


def _manifest(cfg: Config) -> dict:
    p = vault_dir(cfg) / MANIFEST
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def recipients(cfg: Config) -> list[str]:
    p = vault_dir(cfg) / RECIPIENTS
    if not p.is_file():
        return []
    return [ln.strip() for ln in p.read_text(encoding="utf-8").splitlines() if ln.strip().startswith("age1")]


def init(cfg: Config) -> dict:
    """Create this machine's identity when it has none, and add its public key to the recipients."""
    import pyrage
    ip = identity_path(cfg)
    if ip.is_file():
        ident = pyrage.x25519.Identity.from_str(ip.read_text(encoding="utf-8").strip())
        created = False
    else:
        ident = pyrage.x25519.Identity.generate()
        ip.parent.mkdir(parents=True, exist_ok=True)
        ip.write_text(str(ident) + "\n", encoding="utf-8")
        created = True
    pub = str(ident.to_public())
    vd = vault_dir(cfg)
    vd.mkdir(parents=True, exist_ok=True)
    keys = recipients(cfg)
    if pub not in keys:
        keys.append(pub)
        (vd / RECIPIENTS).write_text("\n".join(keys) + "\n", encoding="utf-8")
    return {"identity": str(ip).replace("\\", "/"), "created": created, "public_key": pub, "recipients": len(keys)}


def seal(cfg: Config, force: bool = False) -> dict:
    """Seal the store when its plain content has changed. Returns what was done."""
    import pyrage
    keys = recipients(cfg)
    if not keys:
        return {"sealed": False, "reason": "The store has no recipients. Run python cortex.py vault init first."}
    plain, count = pack(cfg)
    digest = hashlib.sha256(plain).hexdigest()
    if not force and _manifest(cfg).get("sha256") == digest and (vault_dir(cfg) / STORE).is_file():
        return {"sealed": False, "reason": "The memory and overlay have not changed since the last seal.", "files": count}
    rs = [pyrage.x25519.Recipient.from_str(k) for k in keys]
    data = pyrage.encrypt(plain, rs)
    vd = vault_dir(cfg)
    vd.mkdir(parents=True, exist_ok=True)
    tmp = vd / (STORE + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(vd / STORE)
    man = {"v": 1, "sha256": digest, "files": count, "bytes": len(data), "recipients": len(keys),
           "sealed": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "host": platform.node()}
    (vd / MANIFEST).write_text(json.dumps(man, indent=2) + "\n", encoding="utf-8")
    return {"sealed": True, "files": count, "bytes": len(data)}


def status(cfg: Config) -> dict:
    """Whether the store is enabled, whether this machine can open it, and whether it is in step with the files."""
    plain, count = pack(cfg)
    digest = hashlib.sha256(plain).hexdigest()
    man = _manifest(cfg)
    return {"enabled": enabled(cfg), "identity": identity_path(cfg).is_file(), "recipients": len(recipients(cfg)),
            "files": count, "in_step": man.get("sha256") == digest, "sealed": man.get("sealed")}


def open_store(cfg: Config, dry_run: bool = False) -> dict:
    """Decrypt the store and write its files into the memory folder and the overlay of this machine.

    Every file that would be replaced is first copied to <claude_home>/backups/<date>-cortex-vault/, and no file is
    deleted, so a file that exists only on this machine stays.
    """
    import pyrage
    ip = identity_path(cfg)
    if not ip.is_file():
        return {"opened": False, "reason": f"This machine has no identity at {ip}. Copy it from the place where a backup is kept."}
    ident = pyrage.x25519.Identity.from_str(ip.read_text(encoding="utf-8").strip())
    data = pyrage.decrypt((vault_dir(cfg) / STORE).read_bytes(), [ident])
    roots = dict(_sources(cfg))
    backup = cfg.claude_home / "backups" / f"{date.today().isoformat()}-cortex-vault"
    written = backed = 0
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(data)), mode="r") as tar:
        for m in tar.getmembers():
            if not m.isfile():
                continue
            prefix, _, rel = m.name.partition("/")
            if prefix not in roots or not rel or ".." in Path(rel).parts:
                continue
            dest = roots[prefix] / rel
            content = tar.extractfile(m).read()
            if dest.is_file() and dest.read_bytes() == content:
                continue
            if dry_run:
                written += 1
                continue
            if dest.is_file():
                b = backup / prefix / rel
                b.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(dest, b)
                backed += 1
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(content)
            written += 1
    return {"opened": True, "written": written, "backed_up": backed, "dry_run": dry_run}
