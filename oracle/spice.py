"""Minimal reader for the smallsignal netlist dialect (see plan/contract.md).

It only needs to know enough to drive ngspice: element names, node lists,
source values and model types. Values are kept as the original strings.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal

GROUND = {"0", "gnd"}

# SPICE scale suffixes, longest first; letters after a number and its
# suffix are ignored (900mV is 0.9, 1MEGohm is 1e6).
SUFFIX = [("meg", Decimal("1e6")), ("mil", Decimal("25.4e-6")), ("t", Decimal("1e12")), ("g", Decimal("1e9")),
          ("k", Decimal("1e3")), ("m", Decimal("1e-3")), ("u", Decimal("1e-6")), ("n", Decimal("1e-9")),
          ("p", Decimal("1e-12")), ("f", Decimal("1e-15")), ("a", Decimal("1e-18"))]
_NUMBER = re.compile(r"^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)([a-zA-Z]*)$")


def decimal(tok: str) -> Decimal:
    """A netlist number in the dialect (1u, 900m, 2.2k, 1meg, 3e-3) exactly."""
    m = _NUMBER.match(tok.strip())
    if not m:
        raise ValueError(f"bad number {tok!r}")
    rest = m.group(2).lower()
    mult = next((v for s, v in SUFFIX if rest.startswith(s)), Decimal(1))
    return Decimal(m.group(1)) * mult


def value(tok: str) -> float:
    """A netlist number in the dialect as the nearest float."""
    return float(decimal(tok))


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


def element_tokens(line: str) -> list[str]:
    """An element line's tokens as the solver reads them (netlist.rs):
    parentheses and commas separate, and `k = v` is one token `k=v`, so
    `W=10u,L=1u` is two parameters."""
    return re.sub(r"\s*=\s*", "=", re.sub(r"[(),]", " ", line)).split()


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
        pending.append(element_tokens(line))
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


# Series inductance that opens a voltage source for AC while keeping its DC
# value: |Z| = 2π·f·1e12 Ω, about 6e15 Ω at 1 kHz.
OPEN_L = "1e12"


def reserved_names(net: Netlist) -> set[str]:
    """Every name a synthetic node or element must avoid: the netlist's
    element and node names (lower-case) and ground."""
    return {e.name for e in net.elements} | set(net.nodes()) | GROUND


def fresh_name(taken: set[str], base: str) -> str:
    """`base`, or `base` with the smallest numeric suffix, unused by any name
    in `taken` (lower-case; SPICE ignores case), which then reserves it. Keeps
    the first letter, so the element type."""
    name, k = base, 1
    while name.lower() in taken:
        name, k = f"{base}{k}", k + 1
    taken.add(name.lower())
    return name


def render(net: Netlist, ac_source: str | None, extra: list[str] | None = None,
           ac: dict[str, str] | None = None, open_sources: tuple[str, ...] = (),
           taken: set[str] | None = None) -> str:
    """Netlist text with all AC specs stripped and AC 1 placed on `ac_source`
    (or the AC specs in `ac`, by lower-case source name). Sources in
    `open_sources` keep their DC value behind a huge series inductor, so they
    are open for AC. Its node and element names are fresh in `taken` (default
    reserved_names(net)); a caller adding `extra` lines passes the set it
    drew their names from."""
    out = [net.title]
    opened = {n.lower() for n in open_sources}
    taken = reserved_names(net) if taken is None else taken
    for e in net.elements:
        if e.kind in "vi":
            spec = (ac or {}).get(e.name) if ac is not None else (1 if ac_source and e.name == ac_source.lower() else None)
            if e.name in opened:
                inner = fresh_name(taken, f"{e.tokens[1]}__open")
                out.append(f"{e.tokens[0]} {inner} {e.tokens[2]} DC {source_dc(e)}")
                out.append(f"{fresh_name(taken, f'LOPEN__{e.name}')} {e.tokens[1]} {inner} {OPEN_L}")
            else:
                out.append(source_line(e, spec))
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
