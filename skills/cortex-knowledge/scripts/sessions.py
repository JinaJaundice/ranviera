# Copyright 2026 Cortex contributors. Licensed under the Apache License, Version 2.0 (see ../LICENSE).
"""Read the saved teaching and practice sessions of the learning folder.

Usage: sessions.py [--learn-dir PATH] [--format markdown|json] <command>
  list                                          every session, with the files that could not be read named
  read SESSION_ID [--include-agent-thinking] [--include-operations]
The reader keeps what the learner said, answered and thought, with the confidence the learner gave. It leaves out
operational noise and the agent's own thinking unless asked, and it names every omission at the end of its output.
"""
from __future__ import annotations

import argparse
import sys

sys.dont_write_bytecode = True

import json

import _data as D

# Session level and message level keys that record accounting and not teaching.
ACCOUNTING_KEYS = {"settings", "extractions", "turns", "signature", "textSignature", "thinkingLevel",
                   "rawStopReason", "responseId", "thinkingSignature", "stopReason", "usage", "model", "api",
                   "provider"}
OPERATION_TOOLS = {"web_fetch", "web_search", "search", "get_proposition", "get_session", "list_propositions",
                   "list_sessions", "edit", "write", "bash", "find", "grep", "ls", "read"}
LEARNING_TOOLS = {"quiz", "probe", "ask_user_question", "explain", "recall", "problem", "conclude", "probe_done",
                  "plan_init", "research", "pdf", "visual", "demo"}
QUESTION_TOOLS = {"quiz", "probe", "ask_user_question", "explain", "recall"}
PAYLOAD_KEYS = {"html", "svg", "base64", "imageBase64", "dataUrl", "dataURL"}
CONTEXT_MARKERS = {"graph-context", "probe-handoff", "subagent-steer", "subagent-abort", "plan-block",
                   "practice-thinking", "practice-next", "problem-dismissed", "compaction"}
KNOWN_SESSION_KEYS = {"id", "title", "createdAt", "updatedAt", "kind", "version", "messages", "tree"}


class Ledger:
    """The omissions of one read. Each entry names the place and the reason."""

    def __init__(self) -> None:
        self.items: list[dict] = []

    def add(self, source: str, reason: str) -> None:
        self.items.append({"source": source, "reason": reason})


def scrub(value, path: str, ledger: Ledger):
    """A copy of the value without embedded HTML, SVG and base64 payloads, which are never shown or opened."""
    if isinstance(value, dict):
        out = {}
        is_image = value.get("type") == "image"
        for key, item in value.items():
            if key in PAYLOAD_KEYS or (is_image and key == "data"):
                ledger.add(f"{path}.{key}", "embedded payload removed, the reader never renders or opens it")
            else:
                out[key] = scrub(item, f"{path}.{key}", ledger)
        return out
    if isinstance(value, list):
        return [scrub(item, f"{path}[{i}]", ledger) for i, item in enumerate(value)]
    return value


def _text_of(content) -> str | None:
    """The joined text of a content list, when every block is text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list) and content and all(isinstance(b, dict) and b.get("type") == "text"
                                                     and isinstance(b.get("text"), str) for b in content):
        return "\n".join(b["text"] for b in content)
    return None


def _norm(value):
    """Answer fields with the legacy name note read as thinking."""
    if isinstance(value, dict):
        out = {("thinking" if k == "note" else k): _norm(v) for k, v in value.items()}
        return out
    if isinstance(value, list):
        return [_norm(v) for v in value]
    return value


def _contained(small, big) -> bool:
    """True when every value in `small` appears in `big` at the same place."""
    if isinstance(small, dict):
        return isinstance(big, dict) and all(k in big and _contained(v, big[k]) for k, v in small.items())
    if isinstance(small, list):
        return isinstance(big, list) and len(small) <= len(big) and all(_contained(a, b) for a, b in zip(small, big))
    return small == big and type(small) is type(big)


def answer_view(details: dict, path: str, ledger: Ledger) -> dict:
    """The full graded form of an answer. Absent confidence stays absent, and false and zero values survive."""
    clean = _norm(scrub(details, path, ledger))
    if "note" in details and "thinking" not in details:
        clean["thinkingFrom"] = "legacy field note"
    return clean


def tool_result_view(message: dict, index: int, call: dict | None, opts, ledger: Ledger) -> dict:
    name = message.get("toolName")
    base = f"messages[{index}]"
    view = {"toolName": name, "toolCallId": message.get("toolCallId"), "isError": bool(message.get("isError")),
            "callStatus": "bound to a call" if call else "no matching call before it"}
    details = message.get("details")
    content = message.get("content")
    operation = name in OPERATION_TOOLS or name not in LEARNING_TOOLS
    if operation and not message.get("isError") and not opts.include_operations:
        ledger.add(f"{base}.content", f"result of the operation tool {name} dropped by default")
        if details is not None:
            ledger.add(f"{base}.details", f"details of the operation tool {name} dropped by default")
        return view
    if name in QUESTION_TOOLS and isinstance(details, dict):
        view["source"] = "details"
        view["answer"] = answer_view(details, f"{base}.details", ledger)
        text = _text_of(content)
        parsed = None
        if text is not None:
            try:
                parsed = D.parse_json(text)
            except ValueError:
                parsed = None
        if parsed is not None and _contained(_norm(parsed), view["answer"]):
            ledger.add(f"{base}.content", "compact form adds nothing to the details snapshot")
        else:
            view["extraContent"] = scrub(content, f"{base}.content", ledger)
    else:
        if details is not None:
            view["details"] = scrub(details, f"{base}.details", ledger)
        if name in QUESTION_TOOLS and details is None:
            text = _text_of(content)
            try:
                view["answer"] = _norm(scrub(D.parse_json(text), f"{base}.content", ledger))
                view["source"] = "content (parsed JSON, details absent)"
            except (ValueError, TypeError):
                view["content"] = scrub(content, f"{base}.content", ledger)
                view["source"] = "content (details absent)"
        else:
            view["content"] = scrub(content, f"{base}.content", ledger)
    return view


def custom_view(message: dict, index: int, opts, ledger: Ledger) -> dict:
    base = f"messages[{index}]"
    kind = message.get("customType")
    view = {"customType": kind, "label": "context marker" if kind in CONTEXT_MARKERS else "unsupported marker"}
    details = message.get("details")
    if kind == "graph-context" and isinstance(details, dict) and not opts.include_operations:
        props = details.get("propositions") if isinstance(details.get("propositions"), list) else []
        view["details"] = {
            "propositions": [{"id": p.get("id"), "name": p.get("name")} for p in props if isinstance(p, dict)],
            "chains": scrub(details.get("chains", []), f"{base}.details.chains", ledger)}
        ledger.add(f"{base}.content", "graph context text compacted, use --include-operations to restore it")
        ledger.add(f"{base}.details.propositions", "statements of injected propositions dropped by default")
        return view
    view["content"] = scrub(message.get("content"), f"{base}.content", ledger)
    if details is not None:
        view["details"] = scrub(details, f"{base}.details", ledger)
    return view


def build_view(chat: dict, opts) -> dict:
    ledger = Ledger()
    calls: dict[str, dict] = {}
    messages = []
    for index, message in enumerate(chat["messages"]):
        base = f"messages[{index}]"
        role = message["role"]
        item: dict = {"index": index, "id": message.get("id"), "role": role, "timestamp": message.get("timestamp")}
        extras = {}
        for key, value in message.items():
            if key in ACCOUNTING_KEYS:
                if opts.include_operations:
                    extras[key] = scrub(value, f"{base}.{key}", ledger)
                else:
                    ledger.add(f"{base}.{key}", "accounting field dropped by default")
        if role == "user":
            content = message.get("content")
            if isinstance(content, str):
                item["blocks"] = [{"type": "text", "text": content}]
            elif isinstance(content, list):
                item["blocks"] = scrub(content, f"{base}.content", ledger)
            else:
                item["blocks"] = []
        elif role == "assistant":
            blocks = []
            content = message.get("content") if isinstance(message.get("content"), list) else []
            for b_index, block in enumerate(content):
                where = f"{base}.content[{b_index}]"
                if not isinstance(block, dict):
                    blocks.append({"type": "unsupported", "value": scrub(block, where, ledger)})
                elif block.get("type") == "thinking":
                    if opts.include_agent_thinking:
                        blocks.append(scrub(block, where, ledger))
                    else:
                        ledger.add(where, "agent thinking dropped, use --include-agent-thinking")
                elif block.get("type") == "toolCall":
                    call = {"type": "toolCall", "id": block.get("id"), "name": block.get("name")}
                    if isinstance(block.get("id"), str):
                        calls[block["id"]] = call
                    if block.get("name") in LEARNING_TOOLS or opts.include_operations:
                        call["arguments"] = scrub(block.get("arguments"), f"{where}.arguments", ledger)
                    else:
                        ledger.add(f"{where}.arguments", f"arguments of the tool {block.get('name')} dropped by default")
                    blocks.append(call)
                else:
                    blocks.append(scrub(block, where, ledger))
            item["blocks"] = blocks
        elif role == "toolResult":
            call = calls.get(message.get("toolCallId")) if isinstance(message.get("toolCallId"), str) else None
            item["result"] = tool_result_view(message, index, call, opts, ledger)
        elif role == "custom":
            item["marker"] = custom_view(message, index, opts, ledger)
        else:
            item["role"] = "unsupported"
            item["unsupportedRole"] = role
            item["raw"] = scrub(message, base, ledger)
        if extras:
            item["accounting"] = extras
        messages.append(item)
    context = {k: scrub(v, k, ledger) for k, v in chat.items() if k not in KNOWN_SESSION_KEYS and k not in ACCOUNTING_KEYS}
    for key in ACCOUNTING_KEYS & set(chat):
        if opts.include_operations:
            context[key] = scrub(chat[key], key, ledger)
        else:
            ledger.add(key, "session accounting field dropped by default")
    return {"id": chat["id"], "title": chat["title"], "kind": chat.get("kind", "teach"),
            "version": chat.get("version", 1), "createdAt": chat["createdAt"], "updatedAt": chat["updatedAt"],
            "storedContext": context, "messages": messages, "omissions": ledger.items}


# ---------------------------------------------------------------- Markdown

def _field(label: str, value, depth: int = 0) -> list[str]:
    pad = "  " * depth
    if isinstance(value, dict):
        out = [f"{pad}- {D.one_line(label)}:"]
        for k, v in value.items():
            out += _field(LABELS.get(k, k), v, depth + 1)
        return out
    if isinstance(value, list):
        out = [f"{pad}- {D.one_line(label)}:"]
        for i, v in enumerate(value):
            out += _field(f"[{i}] (array position)", v, depth + 1)
        return out
    if isinstance(value, str) and ("\n" in value or len(value) > 120):
        return [f"{pad}- {D.one_line(label)}:"] + [pad + "  " + q for q in D.quoted(value)]
    return [f"{pad}- {D.one_line(label)}: {D.one_line(json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value)}"]


LABELS = {
    "confidence": "Learner confidence (self-reported, 0 to 100, an absent value is not zero)",
    "thinking": "Learner thinking",
    "readingThinking": "Learner thinking while reading",
    "dontKnow": "Learner chose not known",
    "correct": "Graded correct",
    "correctIndices": "Correct display positions",
    "answers": "Learner answers (display positions, not authored order)",
    "target": "Propositions tested",
}


def render_markdown(root, view: dict, opts) -> list[str]:
    md = [f"# {D.one_line(view['title'])}", "",
          f"- Session: {D.one_line(view['id'])}", f"- Kind: {D.one_line(view['kind'])}",
          f"- Format version: {D.one_line(view['version'])}",
          f"- Created: {D.one_line(view['createdAt'])}", f"- Updated: {D.one_line(view['updatedAt'])}",
          f"- Learning folder: {D.one_line(root)}", "", D.NOTICE, ""]
    if view["storedContext"]:
        md += ["## Stored session context", ""]
        for k, v in view["storedContext"].items():
            md += _field(k, v)
        md.append("")
    heads = {"user": "Learner", "assistant": "Teacher", "toolResult": "Tool result", "custom": "Marker",
             "unsupported": "Unsupported"}
    for m in view["messages"]:
        md += [f"## {heads.get(m['role'], 'Unsupported')} (message {m['index']}, id {D.one_line(m['id'])})", ""]
        for block in m.get("blocks", []):
            if block.get("type") == "text":
                md += D.quoted(block.get("text", ""))
            elif block.get("type") == "thinking":
                md += ["Agent thinking:"] + D.quoted(block.get("thinking", ""))
            elif block.get("type") == "toolCall":
                md.append(f"- Tool call {D.one_line(block.get('name'))} (id {D.one_line(block.get('id'))})")
                if "arguments" in block:
                    md += _field("Arguments", block["arguments"], 1)
            else:
                md += _field("Block", block)
            md.append("")
        if "result" in m:
            r = m["result"]
            state = "failed" if r["isError"] else "result recorded"
            md.append(f"- Tool result of {D.one_line(r['toolName'])}, {state}, {r['callStatus']}")
            for key in ("source", "answer", "extraContent", "details", "content"):
                if key in r:
                    md += _field({"answer": "Answer", "extraContent": "Extra content kept"}.get(key, key.capitalize()),
                                 r[key], 1) if key != "source" else [f"  - Read from: {D.one_line(r[key])}"]
            if r["toolName"] in ("problem", "quiz", "probe"):
                md.append("  - Note: stored answer keys and solutions are written by the teacher and are not learner evidence.")
            md.append("")
        if "marker" in m:
            mk = m["marker"]
            md.append(f"- {mk['label'].capitalize()}: {D.one_line(mk['customType'])}")
            for key in ("content", "details"):
                if key in mk:
                    md += _field(key.capitalize(), mk[key], 1)
            md.append("")
        if "raw" in m:
            md += _field(f"Unsupported role {m['unsupportedRole']}", m["raw"])
            md.append("")
        if "accounting" in m:
            md += _field("Accounting fields", m["accounting"])
            md.append("")
    om = view["omissions"]
    md += [f"## Omissions ({len(om)})", ""]
    md += [f"- {D.one_line(o['source'])}: {D.one_line(o['reason'])}" for o in om] or ["None."]
    return md


# ---------------------------------------------------------------- commands

def list_sessions(root, problems: D.Problems) -> list[dict]:
    rows = []
    chats = D.safe_path(root, "chats")
    if not chats.is_dir():
        return rows
    for path in sorted(chats.glob("*.json")):
        chat_id = path.stem
        try:
            chat = D.read_chat(root, chat_id)
        except D.ReaderError as exc:
            problems.add(f"chats/{path.name}", None, str(exc))
            continue
        rows.append({"id": chat["id"], "title": chat["title"], "kind": chat.get("kind", "teach"),
                     "createdAt": chat["createdAt"], "updatedAt": chat["updatedAt"], "messages": len(chat["messages"])})
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(prog="sessions.py", description=__doc__.split("\n")[0])
    D.add_common(parser, top=True)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("list")
    D.add_common(p, top=False)
    p = sub.add_parser("read")
    p.add_argument("session_id")
    p.add_argument("--include-agent-thinking", action="store_true")
    p.add_argument("--include-operations", action="store_true")
    D.add_common(p, top=False)
    args = parser.parse_args()
    root = D.resolve_root(args.learn_dir)
    problems = D.Problems()
    if args.command == "list":
        rows = list_sessions(root, problems)
        md = [f"# Sessions", "", f"Learning folder: {D.one_line(root)}", f"Count: {len(rows)}", ""]
        for r in rows:
            md.append(f"- {D.one_line(r['id'])}, {r['kind']}, {D.one_line(r['title'])}, "
                      f"updated {D.one_line(r['updatedAt'])}, {r['messages']} messages")
        D.emit(args, {"learn_dir": str(root), "count": len(rows), "sessions": rows}, md, problems)
        return 0
    chat = D.read_chat(root, args.session_id)
    view = build_view(chat, args)
    payload = {"learn_dir": str(root), "notice": D.NOTICE, "session": view, "omission_count": len(view["omissions"])}
    D.emit(args, payload, render_markdown(root, view, args), problems)
    return 0


if __name__ == "__main__":
    sys.exit(D.run(main))
