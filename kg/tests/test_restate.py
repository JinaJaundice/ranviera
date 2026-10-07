from cortex_kg import restate
from cortex_kg.model import Harvest, Node


def _rule(rid, path, text, status=None):
    return Node(rid, text[:40], path=path, status=status, props={"text": text})


def test_a_rule_file_bullet_restates_its_closest_reference_bullet():
    h = Harvest("t")
    h.add_node(_rule("rule:decks-001", "C:/Users/x/.claude/rules/decks.md",
                     "Render decks through PowerPoint COM and never LibreOffice (17 Sep 2026)."))
    h.add_node(_rule("rule:orbit-decks-001", "C:/Users/x/.claude/skills/jordan-playbook/references/orbit-decks.md",
                     "Render and export decks only through PowerPoint COM, never LibreOffice."))
    h.add_node(_rule("rule:orbit-decks-002", "C:/Users/x/.claude/skills/jordan-playbook/references/orbit-decks.md",
                     "Use the Orbit template for every slide master."))
    pairs = restate.compute(h)
    assert [(s, t) for s, t, _ in pairs] == [("rule:decks-001", "rule:orbit-decks-001")]
    assert restate.add_edges(h) == 1 and ("rule:decks-001", "restates", "rule:orbit-decks-001") in h.edges


def test_no_pair_below_the_threshold_and_no_superseded_target():
    h = Harvest("t")
    h.add_node(_rule("rule:apps-001", "C:/Users/x/.claude/rules/apps.md", "Every colour is a design token in the app."))
    h.add_node(_rule("rule:ref-001", "C:/Users/x/.claude/skills/jordan-playbook/references/ref.md",
                     "Every colour is a design token in the app.", status="superseded"))
    h.add_node(_rule("rule:ref-002", "C:/Users/x/.claude/skills/jordan-playbook/references/ref.md",
                     "Write the booklet in simple sentences."))
    assert restate.compute(h) == []


SHORT = "C:/Users/x/.claude/rules/x.md"
FULL = "C:/Users/x/.claude/skills/jordan-playbook/references/y.md"


def _pairs(short_text, *full_texts, modal=None):
    h = Harvest("t")
    n = _rule("rule:x-001", SHORT, short_text)
    if modal:
        n.props["modal"] = modal
    h.add_node(n)
    for i, t in enumerate(full_texts, 1):
        h.add_node(_rule(f"rule:y-{i:03d}", FULL, t))
    return h, restate.compute(h)


def test_a_short_bullet_is_not_matched_to_a_long_compound_bullet_that_only_contains_its_words():
    long_text = ("Give a figure's deliverable a version suffix in the file name. Move a superseded version to the "
                 "folder archive and bump every revision. Build scripts and scratch files stay in the scratchpad. "
                 "Academy files take no version suffix. Save finished files in deliverables with a clear name.")
    _h, pairs = _pairs("Move a superseded version to the folder archive and never delete it.", long_text)
    assert pairs == []


def test_a_short_bullet_that_restates_one_clause_of_a_compound_bullet_is_kept():
    long_text = ("Never delete a memory. Log every change in the changelog with the date and the source digest. "
                 "The librarian runs the lock script first and finish last. Nobody writes the last run file by hand.")
    _h, pairs = _pairs("The librarian runs the lock script first and finish last.", long_text)
    assert [(s, t) for s, t, _ in pairs] == [("rule:x-001", "rule:y-001")]


def test_a_negation_mismatch_a_modal_mismatch_and_an_exception_are_not_restatements():
    _h, p = _pairs("Never render decks through LibreOffice.", "Render decks through LibreOffice.")
    assert p == []
    h, _ = _pairs("A part-to-whole split must rely on alpha.", "A part-to-whole split may rely on alpha.", modal="must")
    h.nodes["rule:y-001"].props["modal"] = "may"
    assert restate.compute(h) == []
    _h, p = _pairs("House every exhibit in a filled panel with an Exhibit band.",
                   "Drop the Exhibit bands in the deck. House every exhibit in a filled panel with an Exhibit band.")
    assert p == []


def test_two_equally_good_references_are_left_undecided_and_proposed():
    same = "Check every invented company against Companies House before anything leaves the laptop."
    h, pairs = _pairs(same, same, same)
    assert pairs == [] and len(restate.proposed(h)) == 1


def test_the_edge_says_how_many_rules_restate_one_reference():
    h = Harvest("t")
    for i, t in enumerate(("Keep one main clause in each sentence.", "Keep one main clause in each sentence please."), 1):
        h.add_node(_rule(f"rule:x-{i:03d}", SHORT, t))
    h.add_node(_rule("rule:y-001", FULL, "Keep one main clause in each sentence."))
    assert restate.add_edges(h) == 2
    assert all("2 rule-file rules" in e.evidence for e in h.edges.values())
