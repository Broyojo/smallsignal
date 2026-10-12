import { readSimulationExperimentConfig } from "@icm/model";
import { test, expect } from "@playwright/test";
import { parseProject } from "@icm/project-protocol";
import { unzipSync } from "fflate";

import {
  clickNetlistWorkflowCommand,
  awaitEditorReady,
  exportedProject,
  expectRecovered,
  openProject,
} from "./editor-fixtures.js";
import {
  abortRunsOffering,
  chooseHelperEntry,
  downloadClicked,
  editSimulationFile,
  folderFile,
  ngspiceCapabilities,
  openSimulation,
  ota,
  profile,
  sourceEditor,
} from "./simulation-e2e-fixtures.js";

test("the qualified OTA folder opens unchanged, picks signals on the Canvas and previews root and hierarchical outputs", async ({
  page,
}) => {
  // Signal picking, an export, configuration editing and two downloads. Its
  // assertions are functional, not a 30-second speed budget.
  test.setTimeout(60_000);
  const project = parseProject(JSON.stringify(ota));
  const dut = project.documents.find(
    (document) => document.id === "document-ota-5t",
  )!;
  dut.instances.push({
    id: "I_INTERNAL_PROBE",
    symbolId: "current-source",
    placement: null,
    reference: "I1",
    netlist: {
      binding: { kind: "primitive", deviceClass: "current-source" },
      parameters: { dc: "1u" },
    },
  });
  dut.nets
    .find((net) => net.id === "net-cell-pin-pvdd")!
    .terminals.push({ instanceId: "I_INTERNAL_PROBE", pinName: "+" });
  dut.nets
    .find((net) => net.id === "net-dut-tail")!
    .terminals.push({ instanceId: "I_INTERNAL_PROBE", pinName: "-" });
  const savedSetup = project.simulationFolders[0];
  expect(savedSetup?.input.kind).toBe("source");
  if (savedSetup?.input.kind !== "source")
    throw new Error("qualified OTA fixture folder is not source");
  const parsed = readSimulationExperimentConfig(savedSetup);
  if (!parsed.ok) throw Error(parsed.message);
  const originalSetupInput = parsed.config;
  const config = structuredClone(originalSetupInput);
  expect(originalSetupInput.outputs).toHaveLength(4);
  expect(
    originalSetupInput.outputs.filter(
      (output) =>
        (output.expression.kind === "voltage" ||
          output.expression.kind === "current") &&
        output.expression.occurrence.length > 0,
    ),
  ).toHaveLength(2);
  const executions = await abortRunsOffering(page, {
    ...ngspiceCapabilities(["op", "dc", "ac", "tran"]),
    modelLibrary: {
      path: profile.models.library.runtimePath,
      section: "tt",
    },
  });
  const panel = await openSimulation(
    page,
    project,
    "qualified-ota.icproj.json",
  );
  // New Helper picks write native Code even in a retained legacy experiment.
  await chooseHelperEntry(panel, "Pick Net on Canvas");
  await page.getByTestId("route-hit-tb-vinp-route").click({ force: true });
  await expect(sourceEditor(panel)).toContainText("save ");
  await chooseHelperEntry(panel, "Pick current on Canvas");
  await page.getByTestId("terminal-VINP-+").click();
  await expect(
    page.getByTestId("terminal-VINP-+-current-pick-marker"),
  ).toHaveClass(/origin/u);
  await page.getByTestId("terminal-VINP--").click();
  const canvas = page.getByTestId("schematic-canvas");
  await expect(canvas).toHaveClass(/simulation-terminal-pick-active/);
  await expect(sourceEditor(panel)).not.toBeFocused();
  // Repeated current picks stay active without duplicating native acquisition.
  await page.getByTestId("terminal-VINP-+").click();
  await page.getByTestId("terminal-VINP--").click();
  await expect(canvas).toHaveClass(/simulation-terminal-pick-active/);
  await page.keyboard.press("Escape");
  await expect(canvas).not.toHaveClass(/simulation-terminal-pick-active/);
  await chooseHelperEntry(panel, "Save voltage…");
  const observe = panel.getByRole("dialog", { name: "Save signal" });
  await observe.getByRole("textbox", { name: "Search signal" }).fill("v(out)");
  await observe
    .getByRole("button", { name: "Use native vector: v(out)", exact: true })
    .click();
  const pickedProject: ReturnType<typeof parseProject> =
    await exportedProject(page);
  const pickedConfig = readSimulationExperimentConfig(
    pickedProject.simulationFolders[0]!,
  );
  expect(pickedConfig.ok && pickedConfig.config).toEqual(originalSetupInput);
  const pickedSource = folderFile(
    pickedProject.simulationFolders[0]!,
    savedSetup.input.entry,
  ).text;
  expect(pickedSource).toContain("i(vinp)");
  const circuit = {
    bindingId: savedSetup.input.circuitBindings[0]!.id,
    callPath: [],
  };
  config.outputs.push(
    {
      id: "child-voltage",
      label: "Child input",
      expression: {
        kind: "voltage",
        circuit,
        documentId: "document-ota-5t",
        anchor: { kind: "terminal", instanceId: "PVINP", pinName: "P" },
        occurrence: ["XDUT"],
      },
    },
    {
      id: "supply-current",
      label: "Input current",
      expression: {
        kind: "current",
        circuit,
        documentId: "document-ota-5t-testbench",
        instanceId: "VINP",
        pinName: "+",
        occurrence: [],
      },
    },
    {
      id: "child-current",
      label: "Child current",
      expression: {
        kind: "current",
        circuit,
        documentId: "document-ota-5t",
        instanceId: "I_INTERNAL_PROBE",
        pinName: "+",
        occurrence: ["XDUT"],
      },
    },
  );
  await editSimulationFile(
    page,
    savedSetup.input.configPath,
    JSON.stringify(config, null, 2),
  );
  const runFiles = panel.getByRole("treeitem", { name: "Run", exact: true });
  await runFiles.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Preview input netlist…" }).click();
  await expect(panel.getByLabel("Prepare temporary files")).toHaveCount(0);
  const preview = panel.getByRole("region", { name: "File preview" });
  const deck = (
    await downloadClicked(
      preview.getByRole("button", { name: "Download", exact: true }),
    )
  ).toString();
  for (const vector of [
    "v(vout)",
    "v(ibias)",
    "v(xdut.tail)",
    "v(xdut.nleft)",
    "v(vinp)",
  ])
    expect(deck).toContain(vector);
  expect(deck).toMatch(/i\(vicmprb\d+\)/u);
  expect(deck).toMatch(/i\(v\.xdut\.vicmprb\d+\)/u);
  expect(deck).toMatch(/ac dec 10 1 (?:1000000000|1e\+?9)/i);
  expect(deck).toContain("dc VINP 0.88 0.92 0.005");
  expect(deck).toContain('.lib "icm-models.lib" tt');
  expect(deck).toContain("tran 2e-8 0.000004");
  expect(executions()).toBe(0);
  await runFiles.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "View executed netlist…" }),
  ).toBeDisabled();
  const diagnosticPaths = Object.keys(
    unzipSync(
      await downloadClicked(
        page.getByRole("menuitem", { name: "Export diagnostic bundle…" }),
      ),
    ),
  );
  expect(diagnosticPaths).toContain("netlist/prepared.cir");
  expect(diagnosticPaths).toContain("evidence/source-map.json");
  expect(diagnosticPaths).not.toContain("netlist/executed.cir");
});

test("uncommitted source survives whole-workspace reload", async ({ page }) => {
  await page.route("**/api/simulate", (route) =>
    route.fulfill({ json: { configured: false } }),
  );
  await openProject(page, ota, "source-recovery.icproj.json");
  await expectRecovered(page, ota.id);
  await clickNetlistWorkflowCommand(page, "open-analog-simulation");
  const panel = page.getByRole("region", { name: "Analog simulation" });
  const editor = sourceEditor(panel);
  const marker = "* unsaved recovery 🧪";
  await editor.click();
  await editor.press("Control+End");
  await page.keyboard.insertText(`\n${marker}`);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(sessionStorage)
          .filter((key) => key.startsWith("icm.code-drafts:"))
          .map((key) => sessionStorage.getItem(key))
          .join("\n"),
      ),
    )
    .toContain(marker);
  page.on("dialog", (dialog) => void dialog.accept());
  await page.reload();
  await awaitEditorReady(page);
  // Whole-workspace restoration supersedes the single-document recovery toast.
  // Verify the restored Cell and draft below, without requiring the retired UI.
  await page.getByTestId("hit-XDUT").click();
  await clickNetlistWorkflowCommand(page, "open-analog-simulation");
  await expect(panel.locator(".cm-activeLine")).toContainText("XDUT");
  await expect(editor).not.toBeFocused();
  await panel.getByRole("tab", { name: "run.cir", exact: false }).click();
  await expect(editor).toBeFocused();
  await expect(editor).toContainText(marker);
  const saved: ReturnType<typeof parseProject> = await exportedProject(page);
  expect(
    saved.simulationFolders[0]!.input.files.some((file) =>
      file.text.includes(marker),
    ),
  ).toBe(true);
});
