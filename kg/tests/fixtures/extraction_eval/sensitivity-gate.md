# Sensitivity gate

Every linked source carries one of three sensitivities: public, internal or client-confidential. A client-confidential source may be read only by the Claude Code command line tool or by a model that runs on the person's own machine. A hosted model receives client-confidential text only when the person has recorded consent for that source, and the consent carries the time at which it was given.

A claim takes the highest sensitivity among its sources. For that reason one confidential source is enough to keep a claim away from a hosted model, even when other sources of the same claim are public.

Transcripts and memory files default to client-confidential, because they often hold names and figures from client work.
