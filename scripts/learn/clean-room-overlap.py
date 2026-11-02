"""The clean-room check of the learning upgrade (docs/learning/clean-room.md, 2 November 2026).

Finds runs of consecutive words that Cortex's learning files share with a LearnHarness checkout, so that no prompt,
document or code text of LearnHarness (AGPL-3.0) enters Cortex (Apache 2.0). The check reads the LearnHarness
checkout only to compare, and this script holds none of its text.

Usage: python -I scripts/learn/clean-room-overlap.py <learnharness checkout> [--words N] [--code]
  --words N  the shortest run reported (default 10 for prose, 12 with --code)
  --code     compares the TypeScript, TSX, JavaScript and Python files in place of the Markdown files
Exit code 0 always. Read each run: field names, file names, provider tables and other functional vocabulary are
expected to match, and creative prose is not.
"""
import argparse
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def words(text):
    return re.findall(r"[a-z0-9']+", text.lower())


def main():
    a = argparse.ArgumentParser()
    a.add_argument("learnharness")
    a.add_argument("--words", type=int, default=None)
    a.add_argument("--code", action="store_true")
    o = a.parse_args()
    n = o.words or (12 if o.code else 10)
    lh = Path(o.learnharness)
    kinds = ("*.ts", "*.tsx", "*.py", "*.mjs", "*.cjs", "*.js") if o.code else ("*.md",)
    skip = {".git", "node_modules", ".next", "dist", "out"}
    lh_files = [p for k in kinds for p in lh.rglob(k) if not skip.intersection(p.parts)]
    if o.code:
        # every folder that the learning upgrade added, on the server, in the shared types, in the web app and in the skill
        web = ("/learn/", "/sources/", "/knowledge/", "/settings/models/", "/settings/learning/")
        targets = list((REPO / "server" / "src" / "learn").rglob("*.ts"))
        targets += list((REPO / "shared" / "learn").rglob("*.ts"))
        targets += [p for k in ("*.ts", "*.tsx") for p in (REPO / "web" / "src").rglob(k) if any(s in p.as_posix() for s in web)]
        targets += list((REPO / "skills" / "cortex-knowledge").rglob("*.py"))
        targets += [REPO / "kg" / "cortex_kg" / "harvest" / "knowledge.py"]
        targets += [p for k in ("*.mjs", "*.py") for p in (REPO / "scripts" / "learn").rglob(k)]
        targets += list((REPO / "scripts" / "learn-ui").rglob("*.mjs")) + list((REPO / "desktop").glob("*.cjs"))
    else:
        targets = list((REPO / "server" / "src" / "learn").rglob("*.md")) + list((REPO / "skills" / "cortex-knowledge").rglob("*.md"))
        # every document of the repository, the public README and guides included
        targets += list((REPO / "docs").rglob("*.md")) + list((REPO / "public").rglob("*.md")) + [REPO / "README.md"]
    targets = sorted({p for p in targets if p.is_file()})
    grams = {}
    for p in lh_files:
        w = words(p.read_text(encoding="utf-8", errors="ignore"))
        for i in range(len(w) - n + 1):
            grams.setdefault(" ".join(w[i:i + n]), p.relative_to(lh).as_posix())
    hits = 0
    for p in targets:
        w = words(p.read_text(encoding="utf-8", errors="ignore"))
        i = 0
        while i < len(w) - n + 1:
            g = " ".join(w[i:i + n])
            if g not in grams:
                i += 1
                continue
            j = i + n
            while j < len(w) and " ".join(w[j - n + 1:j + 1]) in grams:
                j += 1
            hits += 1
            print(f"{p.relative_to(REPO).as_posix()}: {j - i} words shared with {grams[g]}: \"{' '.join(w[i:j])[:160]}\"")
            i = j
    print(f"Checked {len(targets)} Cortex files against {len(lh_files)} LearnHarness files at {n} words: {hits} shared runs.")


if __name__ == "__main__":
    main()
