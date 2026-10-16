"""Minimal reader for the smallsignal netlist dialect (see plan/contract.md).

It only needs to know enough to drive ngspice: element names, node lists,
source values and model types. Values are kept as the original strings.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

GROUND = {"0", "gnd"}


@dataclass
class Element:
    name: str  # lower-case
    kind: str  # first letter, lower-case
    tokens: list[str]  # original tokens, tokens[0] is the name
    nodes: list[str]  # lower-case node names


@dataclass
class Netlist:
    title: str
    elements: list[Element] = field(default_factory=list)
    models: dict[str, str] = field(default_factory=dict)  # name -> type (nmos, pmos, npn, pnp, d)
    model_lines: list[str] = field(default_factory=list)
    other_lines: list[str] = field(default_factory=list)  # other dot-commands, kept verbatim

    def element(self, name: str) -> Element:
        for e in self.elements:
            if e.name == name.lower():
                return e
        raise KeyError(f"no element {name!r}")

    def nodes(self) -> list[str]:
        seen: list[str] = []
        for e in self.elements:
            for n in e.nodes:
                if n not in GROUND and n not in seen:
                    seen.append(n)
        return seen


def _strip_comment(line: str) -> str:
    for marker in (";", "$ "):
        i = line.find(marker)
        if i >= 0:
            line = line[:i]
    return line.rstrip()


def logical_lines(text: str) -> tuple[str, list[str]]:
    raw = text.splitlines()
    title = raw[0] if raw else ""
    out: list[str] = []
    in_control = False
    for line in raw[1:]:
        s = line.strip()
        if not s or s.startswith("*"):
            continue
        low = s.lower()
        if low.startswith(".control"):
            in_control = True
            continue
        if low.startswith(".endc"):
            in_control = False
            continue
        if in_control:
            continue
        s = _strip_comment(s)
        if not s:
            continue
        if s.startswith("+"):
            if out:
                out[-1] += " " + s[1:].strip()
            continue
        out.append(s)
    return title, out


def node_count(kind: str, tokens: list[str], models: dict[str, str]) -> int:
    if kind in "rclvid":
        return 2
    if kind in "eg":
        return 4
    if kind in "fh":
        return 2
    if kind == "m":
        return 4
    if kind == "q":
        # Q c b e [sub] model: 4 nodes if tokens[4] is not a model name
        if len(tokens) > 5 and tokens[4].lower() not in models:
            return 4
        return 3
    raise ValueError(f"unsupported element kind {kind!r} ({tokens[0]})")


def parse(text: str) -> Netlist:
    title, lines = logical_lines(text)
    net = Netlist(title=title)
    pending: list[list[str]] = []
    for line in lines:
        low = line.lower()
        if low.startswith(".end") and not low.startswith(".ends"):
            break
        if low.startswith(".model"):
            m = re.match(r"\.model\s+(\S+)\s+([A-Za-z]+)", line, re.I)
            if not m:
                raise ValueError(f"bad .model line: {line}")
            net.models[m.group(1).lower()] = m.group(2).lower()
            net.model_lines.append(line)
            continue
        if low.startswith("."):
            net.other_lines.append(line)
            continue
        pending.append(line.split())
    for tokens in pending:
        kind = tokens[0][0].lower()
        n = node_count(kind, tokens, net.models)
        nodes = [t.lower() for t in tokens[1 : 1 + n]]
        net.elements.append(Element(tokens[0].lower(), kind, tokens, nodes))
    return net


def source_dc(e: Element) -> str:
    """DC value string of an independent V/I source (\"0\" if none)."""
    toks = e.tokens[3:]
    i = 0
    dc = None
    while i < len(toks):
        t = toks[i].lower()
        if t == "dc":
            dc = toks[i + 1]
            i += 2
        elif t == "ac":
            i += 2
            # optional phase
            if i < len(toks) and _is_number(toks[i]):
                i += 1
        else:
            if dc is None:
                dc = toks[i]
            i += 1
    return dc if dc is not None else "0"


def _is_number(tok: str) -> bool:
    return re.match(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[a-zA-Z]*$", tok) is not None


def source_line(e: Element, ac: float | None) -> str:
    """Rebuild an independent source line with its DC value and the given AC magnitude."""
    line = f"{e.tokens[0]} {e.tokens[1]} {e.tokens[2]} DC {source_dc(e)}"
    if ac is not None:
        line += f" AC {ac}"
    return line


def render(net: Netlist, ac_source: str | None, extra: list[str] | None = None) -> str:
    """Netlist text with all AC specs stripped and AC 1 placed on `ac_source`."""
    out = [net.title]
    for e in net.elements:
        if e.kind in "vi":
            out.append(source_line(e, 1 if ac_source and e.name == ac_source.lower() else None))
        else:
            out.append(" ".join(e.tokens))
    out.extend(net.model_lines)
    out.extend(net.other_lines)
    out.extend(extra or [])
    return "\n".join(out) + "\n"


def vexpr(a: str, b: str | None = None) -> str:
    """ngspice expression for v(a) - v(b), handling ground."""
    a = a.lower()
    b = b.lower() if b else None
    pa = None if a in GROUND else f"v({a})"
    pb = None if (b is None or b in GROUND) else f"v({b})"
    if pa and pb:
        return f"{pa}-{pb}"
    if pa:
        return pa
    if pb:
        return f"0-{pb}"
    return "0"
