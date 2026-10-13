"""File writing shared by the stores of the compiler (the rule ledger, the mapping store, the instruction store and the
samples). It imports nothing from the package, so a store loads where an optional module such as the ledger is absent."""
from __future__ import annotations

import os
from pathlib import Path


def write_atomic(path: Path, text: str) -> None:
    """Write a file so that a reader sees the old or the new text, never a part of either: a temporary file in the same
    folder, flushed to disk, then renamed over the target."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
