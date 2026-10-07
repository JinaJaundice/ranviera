# Ranviera: instructions for agents working in this repository

Ranviera is an independent open-source project. It is not affiliated with, endorsed by or sponsored by Anthropic. It runs the Claude Code tool that you install and sign in to yourself, and your use of Claude Code is governed by your own agreement with Anthropic.

Read `docs/ARCHITECTURE.md`, `docs/CONTRACTS.md` and `docs/ONTOLOGY.md` before any change. They are the specification. Read `docs/BRAIN.md` for work on the brain view, `docs/REASONING.md` for work on the rules and `docs/OPERATIONS.md` for work on installation, hooks and releases.

## Contracts change first

A change to a data shape, an API route, an event kind, a class or a relation is made in `docs/CONTRACTS.md` or `docs/ONTOLOGY.md` first, with its date, and then in every part that uses it. Where a task needs a change in a file that another task owns, describe the change and do not edit the file.

## Checks to run

- Python: from `kg/`, run `python -m pytest -q`.
- Types: from the repository root, run `npx tsc -b --noEmit`.
- Web: run `npx eslint .`, `npx vitest run` and `npx vite build`.
- Public tree: run `node --test scripts/public/` and `node scripts/public/check.mjs .` before a release.
- Interface work: run `npm run smoke` against the running server and look at every screenshot in `shots/`.

Run the whole chain once at the end of a task, not after each edit.

## House rules

- Text that a person reads uses measured sentences, UK English and sentence case, and has no dashes, semicolons in prose, contractions, exclamation marks or marketing words.
- Every colour is a token in `web/src/index.css`. Icons are Lucide and there is no emoji. Text uses the type ladder classes with an 11px floor and no arbitrary sizes. The radius is at most 6px, and grid children take `min-w-0`.
- Nothing is deleted. A superseded file moves to an `archive/` folder beside it.

## Never

- Never read, write or run a build against the real `~/.claude` of the person using the machine in a test. Make a temporary Claude folder with a small sample and point the configuration at it with `CORTEX_CONFIG`.
- Never collect, store, log or pass on a Claude credential, session token or sign-in code, and never return the output of `claude auth status` beyond the five fields of `GET /api/claude`.
- Never use the names or logos of Claude, Claude Code or Anthropic in the name, logo or icon of the product.
- Never put personal or client content, a secret, an absolute path to a user folder or an e-mail address in a committed file. `node scripts/public/check.mjs` finds these.
- Never commit, push or create a release without the explicit agreement of the maintainer.
