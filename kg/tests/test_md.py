from cortex_kg import md


def kind_of(text, heading="Rules", path="rules/x.md", parent=None):
    return md.classify(text, heading, path, parent)


def test_modal_reads_the_head_before_a_later_modal_verb():
    assert md.modal_of("Draw a chart at the width it will be placed (19 Aug 2026).") == "imperative"
    assert md.modal_of("Implement dark mode with a script that must run before first paint.") == "imperative"
    assert md.modal_of("When an item moves, re-read every other page that says so.") == "imperative"
    assert md.modal_of("No dashes and no semicolons. A full stop replaces each.") == "imperative"
    assert md.modal_of("Fit the data window to the aspect of the figure.") == "imperative"
    assert md.modal_of("Emphasise with a recoloured phrase and do not use bold alone.") == "imperative"


def test_modal_reads_a_later_clause_that_forbids_or_commands():
    assert md.modal_of("Each word maps to one meaning \u2014 don't rely on context.") == "imperative"
    assert md.modal_of("Skills lines are separated phrases; put a non-breaking space before each.") == "imperative"


def test_modal_verbs_and_none():
    assert md.modal_of("A part-to-whole split must not rely on alpha.") == "must"
    assert md.modal_of("\"May\" and \"could\" state a possibility.") == "may"
    assert md.modal_of("Python 3.14 has python-pptx and openpyxl.") == "none"


def test_a_list_of_paths_a_definition_and_an_example_are_notes():
    assert kind_of("`a/b.md`")[1] == "note"
    assert kind_of("`~/.claude/rules/decks.md`, `documents.md` and `visuals.md`")[1] == "note"
    assert kind_of("Use the old template.", heading="Examples")[1] == "note"
    assert kind_of("42 words, over the 20-word instruction cap.", path="skills/x/examples/before-after.md")[1] == "note"
    assert kind_of("[The guide](FCA_REGISTER.md)")[1] == "note"
    assert kind_of("Use the template.", parent="note")[1] == "note"


def test_an_instruction_is_an_instruction_and_a_ban_heading_makes_a_bare_item_one():
    assert kind_of("Keep one source line on each page.") == ("imperative", "instruction", False)
    assert kind_of("Never write RFB.")[1:] == ("instruction", True)
    assert kind_of("Every chart has a legend.")[1] == "instruction"
    modal, kind, neg = kind_of("Contractions and exclamation marks", heading="Banned words")
    assert (modal, kind, neg) == ("imperative", "instruction", True)
