# Audit and merge

Three extractors may run at the same time, and they share three permits with all other background model work. Waiting extractors are served in the order in which they asked.

The audit and the merge run one at a time, in the same first in first out order. The auditor compares new propositions with the propositions already in the graph, so it must see the graph after every earlier merge. If two audits ran together, each would link into a graph that the other was about to change, and both could add a copy of the same proposition.

The auditor never sees the source text. It receives the new propositions and five ranked candidates for each, and it returns identity links only.
