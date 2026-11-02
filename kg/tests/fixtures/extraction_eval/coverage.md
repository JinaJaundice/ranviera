# Coverage of a transcript

Coverage records which messages the extractor has already read. Each message has a fingerprint, which is the SHA-256 hash of its role and its text as the extractor sees it. A message is covered when its fingerprint appears in the coverage file for the same source.

Editing a message changes its fingerprint, so only that message becomes uncovered again. Messages that were not edited stay covered.

The coverage lines are written last in a merge. If a run stops before the merge, its batch stays uncovered, and the next run reads that batch again.
