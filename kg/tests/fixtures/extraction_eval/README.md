# Extraction evaluation set

Four short notes about how Cortex extracts knowledge, with claims written by hand in `expected.json`. Each claim lists words that a proposition must contain (case ignored) to count as a match. The set measures recall (the share of expected claims that the pipeline found) and precision (the share of produced propositions that match an expected claim), and it counts statements about the note itself.

Run it by hand against the configured model with `node scripts/learn/eval-extraction.mjs`. The tests never run it against a model. `node scripts/learn/eval-extraction.mjs --dry-run` scores the expected claims against themselves and needs no model.
