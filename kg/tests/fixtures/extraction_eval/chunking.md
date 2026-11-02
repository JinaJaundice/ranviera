# Chunking

The extractor reads a file in chunks. A chunk holds at most 4,096 estimated tokens, and the estimate is the number of characters divided by four, rounded up. The person can lower the budget in the settings, but never below 500 tokens.

A line is never split. When one line is longer than the whole budget, it forms a chunk of its own. Each chunk is labelled with the path of its file and, when the file has several chunks, with its part number, so that the model knows where the passage sits.

Chunks of one file are read in order. The extractor for a later chunk receives a digest of what the earlier chunks produced, which lets it refer to existing propositions by their identifiers.
