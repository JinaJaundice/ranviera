# PyInstaller spec for the Ranviera compiler: a folder that holds the executable ranviera-kg and its libraries.
# Build it with: node scripts/build/kg.mjs (it runs PyInstaller with this file, from the repository root).
import os
from PyInstaller.utils.hooks import collect_all

ROOT = SPECPATH + "/../.."

datas, binaries, hiddenimports = [], [], []
# The compiler loads its own modules by name (cortex_kg.harvest.*, cortex_kg.reason and so on), so PyInstaller cannot
# see them. The libraries carry data files, such as the pySHACL shapes and the rdflib plugins.
# They are listed from the source folder, because PyInstaller's collector imports installed packages only.
_src = os.path.join(ROOT, "kg")
for _dir, _dirs, _files in os.walk(os.path.join(_src, "cortex_kg")):
    _dirs[:] = [d for d in _dirs if d != "__pycache__"]
    _rel = os.path.relpath(_dir, _src).replace(os.sep, ".")
    hiddenimports.append(_rel)
    hiddenimports += [_rel + "." + f[:-3] for f in _files if f.endswith(".py") and f != "__init__.py"]
# harvest/harness.py reads its own source to cite the line of the BUILTINS list, so the file travels as data too.
datas.append((os.path.join(_src, "cortex_kg", "harvest", "harness.py"), "cortex_kg/harvest"))
for pkg in ("rdflib", "pyshacl", "owlrl", "nmo_python", "pyrage", "prettytable", "packaging"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

a = Analysis(
    [ROOT + "/packaging/kg/entry.py"],
    pathex=[ROOT + "/kg"],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["pytest", "tkinter", "matplotlib", "numpy.tests"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="ranviera-kg", console=True, upx=False)
coll = COLLECT(exe, a.binaries, a.datas, name="kg", upx=False)
