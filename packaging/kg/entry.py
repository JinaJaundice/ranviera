"""Entry point of the bundled compiler: ranviera-kg <command>. PyInstaller builds it from packaging/kg/ranviera-kg.spec."""
import multiprocessing
import sys

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

from cortex_kg.__main__ import main  # noqa: E402

if __name__ == "__main__":
    multiprocessing.freeze_support()
    sys.exit(main())
