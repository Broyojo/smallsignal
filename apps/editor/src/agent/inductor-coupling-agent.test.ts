import { expect, it } from "vitest";
import { callTool, type ToolSessionState } from "../../../mcp-server/src/tools";
import { liveAgentEditor } from "./live-agent-editor.test-support";

function parseText(result: { content: { type: string; text?: string }[] }) {
  expect(result.content[0]?.type).toBe("text");
  return JSON.parse(result.content[0]!.text!);
}

/** The MCP tools an Agent calls, on the live editor, connected. */
async function connected() {
  const editor = liveAgentEditor();
  const session: ToolSessionState = { client: editor.client };
  const tool = async (name: string, args: unknown) =>
    parseText(await callTool(name, args, session));
  expect(await tool("connect", { claimCode: "session-1.code" })).toMatchObject({
    ok: true,
  });
  return { ...editor, tool };
}

const inductor = (reference: string) => ({ kind: "instance", reference });

it("couples two inductors by Reference, reads them back and netlists the K (#1648)", async () => {
  const { controller, tool } = await connected();
  const placed = await tool("circuit_place", {
    actions: [
      {
        kind: "place-component",
        symbol: "inductor",
        reference: "L1",
        position: { x: 100, y: 100 },
        parameters: { value: "1u" },
      },
      {
        kind: "place-component",
        symbol: "inductor",
        reference: "L2",
        position: { x: 300, y: 100 },
        parameters: { value: "4u" },
      },
    ],
  });
  expect(placed.ok, JSON.stringify(placed)).toBe(true);
  for (const pin of ["1", "2"]) {
    const wired = await tool("circuit_wire", {
      actions: [
        {
          kind: "connect",
          from: { kind: "pin", instance: "L1", pin },
          to: { kind: "pin", instance: "L2", pin },
        },
      ],
    });
    expect(wired.ok, JSON.stringify(wired)).toBe(true);
  }

  const coupled = await tool("circuit_selection", {
    actions: [
      {
        kind: "couple-inductors",
        inductors: [inductor("L1"), inductor("L2")],
        k: "0.9",
        dots: [null, "2"],
      },
    ],
  });
  expect(coupled.ok, JSON.stringify(coupled)).toBe(true);
  const ids = Object.fromEntries(
    controller.document.instances.map((item) => [item.reference, item.id]),
  );
  expect(controller.document.inductorCouplings).toEqual([
    {
      id: expect.any(String),
      name: "TF1",
      members: [
        { instanceId: ids.L1, dotPin: "1" },
        { instanceId: ids.L2, dotPin: "2" },
      ],
      k: "0.9",
    },
  ]);
  const document = await tool("inspect", {
    target: { kind: "document" },
    detail: "full",
  });
  expect(document.inductorCouplings).toEqual([
    {
      id: controller.document.inductorCouplings![0]!.id,
      name: "TF1",
      members: [
        { instanceId: ids.L1, reference: "L1", dotPin: "1" },
        { instanceId: ids.L2, reference: "L2", dotPin: "2" },
      ],
      k: "0.9",
    },
  ]);
  const netlist = await tool("netlist_code", { action: "read" });
  expect(netlist.netlist.status, JSON.stringify(netlist)).toBe("ready");
  expect(netlist.netlist.text).toMatch(/^KTF1 L1 L2 0\.9$/mu);
  // L2 is dotted at its pin 2, so its card starts there.
  const l2 = (netlist.netlist.text as string)
    .split("\n")
    .find((line) => line.startsWith("L2 "))!;
  const l1 = (netlist.netlist.text as string)
    .split("\n")
    .find((line) => line.startsWith("L1 "))!;
  expect(l2.split(" ").slice(1, 3)).toEqual(
    [...l1.split(" ").slice(1, 3)].reverse(),
  );

  // Asking again changes only what it names; delete uncouples, one undo
  // brings the coupling back.
  expect(
    (
      await tool("circuit_selection", {
        actions: [
          {
            kind: "couple-inductors",
            inductors: [inductor("L2"), inductor("L1")],
            arrow: false,
          },
        ],
      })
    ).ok,
  ).toBe(true);
  expect(controller.document.inductorCouplings![0]).toMatchObject({
    name: "TF1",
    k: "0.9",
    arrow: false,
  });
  const removed = await tool("apply_actions", {
    actions: [
      { kind: "delete", target: { kind: "inductor-coupling", name: "TF1" } },
    ],
  });
  expect(removed.ok, JSON.stringify(removed)).toBe(true);
  expect(controller.document.inductorCouplings).toBeUndefined();
  expect(
    (await tool("inspect", { target: { kind: "document" }, detail: "full" }))
      .inductorCouplings,
  ).toBeUndefined();
  expect(
    (await tool("apply_actions", { actions: [{ kind: "undo" }] })).ok,
  ).toBe(true);
  expect(controller.document.inductorCouplings).toHaveLength(1);

  const refused = await tool("circuit_selection", {
    actions: [
      {
        kind: "couple-inductors",
        inductors: [inductor("L1"), inductor("L1")],
      },
    ],
  });
  expect(refused).toMatchObject({ ok: false, actionKind: "couple-inductors" });
  expect(JSON.stringify(refused)).toContain("two different inductors");
});
