"""Launcher: python cortex.py <command>. See docs/ARCHITECTURE.md for the commands."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "kg"))
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

from cortex_kg.__main__ import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
