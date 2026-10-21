import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { AssumptionTerm } from "@icm/small-signal";
import type { RegionChoice } from "./small-signal-assumption-store";
import type { PartField } from "./small-signal-part-fields";

// A part where it is drawn: an anchored menu beside it on the canvas with
// its values and assumptions, and a badge on each part that has any
// assumption in effect. Values write the drawing; assumptions read and
// write the Assumptions table's store through the panel.

/** A neglected term (or the leakage column) as a toggle. */
export interface MenuToggle {
  /** A term, or "leakage" for r_bs, r_bd and r_μ together. */
  id: AssumptionTerm | "leakage";
  on: boolean;
  /** Members of a matched group differ. */
  mixed: boolean;
  /** On through its type's default ("All NMOS"), not the part's own. */
  inherited: boolean;
}

export type PassiveChoice = "" | "open" | "short" | "miller";

export interface DeviceMenuModel {
  /** "M1", or a matched group's "M1 = M2". */
  label: string;
  /** "NMOS", "Capacitor". */
  typeLabel: string;
  /** The other members of a matched group the choices apply to. */
  matchedWith: string[];
  /** The type row a default comes from ("All NMOS"). */
  defaultsLabel: string | null;
  neglect: MenuToggle[];
  /** C_gd or C_μ split by Miller, where it bridges two signal nodes. */
  miller: { term: AssumptionTerm; on: boolean; mixed: boolean }[];
  /** Open, short or Miller (capacitors, diodes); null for transistors. */
  passive: { value: PassiveChoice; options: PassiveChoice[] } | null;
  /** MOSFETs: the assumed region, "" for the bias's. */
  region: RegionChoice | "" | null;
}

export interface DeviceMenuStatus {
  /** The bias's region ("triode"), null without a bias. */
  bias: string | null;
  /** The solver's sentences about this part ("M1 bias says triode"). */
  notes: string[];
  /** "Gain 2.1% from full model" while anything is assumed. */
  cost: string | null;
}

export interface DeviceMenuActions {
  toggle(item: MenuToggle): void;
  miller(term: AssumptionTerm, on: boolean): void;
  passive(choice: PassiveChoice): void;
  region(region: RegionChoice | ""): void;
  /** Writes a typed value to the drawing; false when it is not one. */
  field(field: PartField, text: string): boolean;
  /** The part's full Properties. */
  more?: (() => void) | undefined;
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "Tab"]);

const SUB: Record<string, string> = {
  cgs: "gs",
  cgd: "gd",
  cgb: "gb",
  cbd: "db",
  cbs: "sb",
  cpi: "π",
  cmu: "μ",
  ccs: "cs",
  cj: "j",
  ro: "o",
  gmb: "mb",
  rpi: "π",
};

/** r_o, g_mb, C_gs… as the equations write them. */
export function TermLabel({ id }: { id: string }) {
  if (id === "leakage") return <>Leakage</>;
  const head = id === "gmb" ? "g" : id.startsWith("c") ? "C" : "r";
  return (
    <>
      {head}
      <sub>{SUB[id] ?? id.slice(1)}</sub>
    </>
  );
}

/** Plain-text name of a term, for labels read aloud. */
export function termText(id: string): string {
  if (id === "leakage") return "leakage";
  const head = id === "gmb" ? "g" : id.startsWith("c") ? "C" : "r";
  return `${head}_${SUB[id] ?? id.slice(1)}`;
}

const REGION_LABEL: Record<RegionChoice | "", string> = {
  "": "Auto",
  saturation: "Saturation",
  triode: "Triode",
};

const PASSIVE_LABEL: Record<PassiveChoice, string> = {
  "": "Keep",
  open: "Open",
  short: "Short",
  miller: "Miller",
};

export interface Placement {
  left: number;
  top: number;
}

const GAP = 10;
const MARGIN = 8;

/**
 * Where the menu goes: beside the part, on whichever side has room inside
 * `bounds` (the canvas), top-aligned with it and kept on screen.
 */
export function menuPlacement(
  anchor: { left: number; top: number; right: number; bottom: number },
  size: { width: number; height: number },
  bounds: { left: number; top: number; right: number; bottom: number },
): Placement {
  const right = anchor.right + GAP;
  const left = anchor.left - GAP - size.width;
  const x =
    right + size.width <= bounds.right - MARGIN
      ? right
      : left >= bounds.left + MARGIN
        ? left
        : Math.max(
            bounds.left + MARGIN,
            Math.min(right, bounds.right - MARGIN - size.width),
          );
  const y = Math.max(
    bounds.top + MARGIN,
    Math.min(anchor.top, bounds.bottom - MARGIN - size.height),
  );
  return { left: Math.round(x), top: Math.round(y) };
}

/** Narrow screens get a sheet along the bottom instead of a popover. */
export const SHEET_BELOW_PX = 600;

/** One option of a segmented control; arrows move between them. */
function Segmented<T extends string>({
  label,
  value,
  options,
  text,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  text: (option: T) => string;
  onChange(value: T): void;
}) {
  const move = (event: ReactKeyboardEvent<HTMLButtonElement>, at: number) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const next = options[(at + step + options.length) % options.length];
    if (next === undefined) return;
    onChange(next);
    const group = event.currentTarget.parentElement;
    requestAnimationFrame(() =>
      group?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus(),
    );
  };
  return (
    <div
      className="small-signal-segmented"
      role="radiogroup"
      aria-label={label}
    >
      {options.map((option, at) => (
        <button
          key={option || "none"}
          type="button"
          role="radio"
          aria-checked={option === value}
          tabIndex={option === value ? 0 : -1}
          onClick={() => onChange(option)}
          onKeyDown={(event) => move(event, at)}
        >
          {text(option)}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  pressed,
  mixed = false,
  inherited = false,
  title,
  label,
  onClick,
  children,
}: {
  pressed: boolean;
  mixed?: boolean;
  inherited?: boolean;
  title?: string | undefined;
  label: string;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="small-signal-chip"
      aria-pressed={mixed ? "mixed" : pressed}
      aria-label={label}
      data-inherited={inherited || undefined}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** A value, applied on Enter or leaving the field; Esc closes unchanged. */
export function ValueField({
  field,
  label,
  readOnly = false,
  onCommit,
}: {
  field: PartField;
  /** Read aloud: "R1 Value", "VINP DC". */
  label: string;
  readOnly?: boolean | undefined;
  onCommit(text: string): boolean;
}) {
  const [text, setText] = useState(field.value);
  const [invalid, setInvalid] = useState(false);
  // The drawing changed under it (undo, another edit): show what it says.
  useEffect(() => {
    setText(field.value);
    setInvalid(false);
  }, [field.value]);
  const commit = () => {
    if (text.trim() === field.value.trim()) {
      setInvalid(false);
      return true;
    }
    const ok = onCommit(text);
    setInvalid(!ok);
    return ok;
  };
  return (
    <label className="small-signal-device-menu-field">
      <span>{field.label}</span>
      <input
        aria-label={label}
        readOnly={readOnly}
        aria-invalid={invalid || undefined}
        value={text}
        placeholder={field.placeholder}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => {
          setText(event.currentTarget.value);
          setInvalid(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (commit()) event.currentTarget.select();
          }
        }}
        onBlur={() => {
          if (!commit()) {
            setText(field.value);
            setInvalid(false);
          }
        }}
      />
      {/* Always a cell: the grid is label, field, unit on every row. */}
      <span
        className="small-signal-muted"
        aria-hidden={!field.unit || undefined}
      >
        {field.unit}
      </span>
    </label>
  );
}

/**
 * The menu itself: the part's values, what it neglects, its Miller
 * splits, open or short, and a MOSFET's region, each applied as soon as it
 * is chosen.
 */
export function DeviceMenu({
  model,
  part,
  fields,
  status,
  actions,
  anchor,
  bounds,
  focusOnOpen,
  onClose,
  nonlinear = null,
}: {
  model: DeviceMenuModel;
  /** The clicked part, "M1": its values are its own, even when matched. */
  part: string;
  /** Its values as drawn; empty for a part with none. */
  fields: readonly PartField[];
  status: DeviceMenuStatus;
  actions: DeviceMenuActions;
  /** The part's box on screen, measured every frame; null when gone. */
  anchor(): DOMRect | null;
  /** The canvas's box on screen. */
  bounds(): DOMRect | null;
  /** Opened from the keyboard: focus moves into the menu. */
  focusOnOpen: boolean;
  /** Esc, the close button, or a press elsewhere. */
  onClose(restoreFocus: boolean): void;
  /** Whether Distortion expands this part (a biased transistor or diode);
   * null when it cannot. */
  nonlinear?: { on: boolean; set(on: boolean): void } | null;
}) {
  const ref = useRef<HTMLElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [sheet, setSheet] = useState(() => window.innerWidth < SHEET_BELOW_PX);

  // Follows the part through pans, zooms and moves, and closes when the
  // part is gone.
  useLayoutEffect(() => {
    let frame = 0;
    let last = "";
    const place = () => {
      const narrow = window.innerWidth < SHEET_BELOW_PX;
      setSheet(narrow);
      const box = anchor();
      const menu = ref.current;
      if (!box) {
        onClose(false);
        return;
      }
      if (menu && !narrow) {
        const area = bounds() ?? new DOMRect(0, 0, innerWidth, innerHeight);
        const next = menuPlacement(
          box,
          { width: menu.offsetWidth, height: menu.offsetHeight },
          {
            left: Math.max(area.left, 0),
            top: Math.max(area.top, 0),
            right: Math.min(area.right, innerWidth),
            bottom: Math.min(area.bottom, innerHeight),
          },
        );
        const key = `${next.left},${next.top}`;
        if (key !== last) {
          last = key;
          setPlacement(next);
        }
      }
      frame = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, [anchor, bounds, onClose]);

  useEffect(() => {
    if (!focusOnOpen) return;
    // After the selection it came with has settled (the canvas may take
    // focus for it).
    // The first choice, not Close: a value, a toggle, else the checked
    // option.
    const frame = requestAnimationFrame(() => {
      const menu = ref.current;
      const value = menu?.querySelector<HTMLInputElement>("input");
      if (value) {
        value.focus();
        value.select();
        return;
      }
      (
        menu?.querySelector<HTMLElement>("button[aria-pressed]") ??
        menu?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]') ??
        menu?.querySelector<HTMLElement>("button")
      )?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusOnOpen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        // A key typed at the drawing (C, I, W, Delete, …) is the drawing's
        // shortcut: the menu steps aside for it.
        if (
          !MODIFIER_KEYS.has(event.key) &&
          !ref.current?.contains(document.activeElement)
        )
          onClose(false);
        return;
      }
      // The menu's own Esc: the canvas keeps its selection.
      event.stopImmediatePropagation();
      event.preventDefault();
      onClose(ref.current?.contains(document.activeElement) ?? false);
    };
    const onPress = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (
        ref.current?.contains(target) ||
        target?.closest?.("[data-small-signal-badge]")
      )
        return;
      onClose(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPress, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPress, true);
    };
  }, [onClose]);

  const transistor = model.passive === null;
  const caps = model.neglect.filter(
    (item) => item.id.startsWith("c") && item.id !== "cj",
  );
  const others = model.neglect.filter((item) => !caps.includes(item));
  const toggle = (item: MenuToggle) => (
    <Toggle
      key={item.id}
      pressed={item.on}
      mixed={item.mixed}
      inherited={item.inherited}
      label={`Neglect ${termText(item.id)}`}
      title={
        item.inherited && model.defaultsLabel
          ? `From ${model.defaultsLabel}`
          : undefined
      }
      onClick={() => actions.toggle(item)}
    >
      <TermLabel id={item.id} />
    </Toggle>
  );
  const millerFor = (term: string) =>
    model.miller
      .filter((split) => split.term === term)
      .map((split) => (
        <Toggle
          key={`miller-${split.term}`}
          pressed={split.on}
          mixed={split.mixed}
          label={`Miller split of ${termText(split.term)}`}
          onClick={() => actions.miller(split.term, !split.on)}
        >
          Miller <TermLabel id={split.term} />
        </Toggle>
      ));
  const regionChanged =
    status.bias !== null &&
    model.region !== null &&
    model.region !== "" &&
    model.region !== status.bias;

  const menu = (
    <section
      ref={ref}
      className={`small-signal-device-menu${sheet ? " is-sheet" : ""}`}
      role="dialog"
      aria-label={model.label}
      data-testid="small-signal-device-menu"
      style={
        sheet || !placement
          ? sheet
            ? undefined
            : { visibility: "hidden", left: 0, top: 0 }
          : { left: placement.left, top: placement.top }
      }
    >
      <header>
        <strong>{model.label}</strong>
        <span className="small-signal-muted">{model.typeLabel}</span>
        {status.bias ? (
          <span className="small-signal-device-menu-bias">
            bias{" "}
            <span className={`small-signal-region is-${status.bias}`}>
              {status.bias}
            </span>
          </span>
        ) : null}
        <button
          type="button"
          className="small-signal-device-menu-close"
          aria-label="Close"
          onClick={() => onClose(true)}
        >
          ×
        </button>
      </header>
      {fields.length ? (
        <div
          className="small-signal-device-menu-section small-signal-device-menu-fields"
          role="group"
          aria-label={`${part} values`}
        >
          {model.matchedWith.length ? <h3>{part}</h3> : null}
          {fields.map((field) => (
            <ValueField
              key={field.name}
              field={field}
              label={`${part} ${field.label}`}
              onCommit={(text) => actions.field(field, text)}
            />
          ))}
        </div>
      ) : null}
      {model.matchedWith.length ? (
        <p className="small-signal-muted">
          Matched with {model.matchedWith.join(", ")}. Assumptions apply to all.
        </p>
      ) : null}
      {model.passive ? (
        <div className="small-signal-device-menu-section">
          <Segmented
            label={`${model.label} open, short or Miller`}
            value={model.passive.value}
            options={model.passive.options}
            text={(option) => PASSIVE_LABEL[option]}
            onChange={actions.passive}
          />
        </div>
      ) : null}
      {model.neglect.length || model.miller.length ? (
        <div
          className="small-signal-device-menu-section"
          role="group"
          aria-label="Neglect"
        >
          <h3>Neglect</h3>
          {others.length ? (
            <div className="small-signal-chips">{others.map(toggle)}</div>
          ) : null}
          {caps.length ? (
            <div className="small-signal-chips">
              {caps.flatMap((item) => [toggle(item), ...millerFor(item.id)])}
            </div>
          ) : null}
        </div>
      ) : null}
      {transistor && model.region !== null ? (
        <div className="small-signal-device-menu-section">
          <h3>Region</h3>
          <Segmented
            label={`${model.label} region`}
            value={model.region}
            options={["", "saturation", "triode"] as const}
            text={(option) => REGION_LABEL[option]}
            onChange={actions.region}
          />
        </div>
      ) : null}
      {nonlinear ? (
        <div
          className="small-signal-device-menu-section"
          role="group"
          aria-label="Distortion"
        >
          <h3>Distortion</h3>
          <div className="small-signal-chips">
            <Toggle
              pressed={nonlinear.on}
              label={`${part} nonlinear`}
              onClick={() => nonlinear.set(!nonlinear.on)}
            >
              Nonlinear
            </Toggle>
          </div>
        </div>
      ) : null}
      {status.notes.length ? (
        <ul
          className={`small-signal-device-menu-notes${regionChanged ? " is-assumed" : ""}`}
        >
          {status.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      {status.cost || actions.more ? (
        <footer className="small-signal-muted">
          {status.cost ? <span data-cost>{status.cost}</span> : null}
          {actions.more ? (
            <button
              type="button"
              className="small-signal-link-button"
              onClick={actions.more}
            >
              More properties
            </button>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
  return createPortal(menu, document.body);
}

export interface CanvasBadge {
  instanceId: string;
  /** The netlist name, "M1". */
  element: string;
  /** What shows: "Sat", "Triode", "Open", "≈". */
  text: string;
  /** Read aloud and on hover: "M1: saturation assumed, r_o neglected". */
  description: string;
  /** The bias disagrees with the assumed region, or refused it. */
  warn: boolean;
}

/** A drawn part's hit target on the canvas, by instance id. */
export function instanceHit(id: string): Element | null {
  return document.querySelector(
    `[data-testid="schematic-canvas"] [data-canvas-hit-kind="instance"][data-canvas-hit-id="${CSS.escape(id)}"]`,
  );
}
