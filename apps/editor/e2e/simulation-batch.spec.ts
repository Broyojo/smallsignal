import {
  createSimulationFolder,
  readSimulationExperimentConfig,
  replaceSimulationExperimentConfig,
} from "@icm/model";
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseProject } from "@icm/project-protocol";

import {
  clickNetlistWorkflowCommand,
  openProjectFile,
} from "./editor-fixtures.js";
import {
  completedNgspiceRun,
  editSimulationFile,
  ngspiceCapabilities,
  ota,
  profile,
} from "./simulation-e2e-fixtures.js";

// Both batch entries are GUI wiring: a saved Run Plan and a multi-selection of
// saved folders. Their expansion and sequential execution are
// mcp-simulation-live's "prepares and runs saved folders as ordinary
// sequential runs" and the simulation-service tests.
test("a Run Plan prepares without executing, and saved folders run as one batch of ordinary runs", async ({
  page,
}) => {
  const project = parseProject(JSON.stringify(ota));
  let plan = project.simulationFolders[0]!;
  const parsed = readSimulationExperimentConfig(plan);
  if (!parsed.ok) throw Error(parsed.message);
  const config = parsed.config;
  config.outputs = [];
  config.runPlan = {
    mode: "sweep",
    axes: [
      { kind: "variable", variableId: "input-level", values: ["0.89", "0.9"] },
    ],
  };
  config.variables = [
    {
      id: "input-level",
      name: "VIN",
      sourcePath: plan.input.entry,
      bindings: [
        {
          documentId: project.topDocumentId,
          instanceId: "VINP",
          parameter: "low",
        },
      ],
    },
  ];
  plan = replaceSimulationExperimentConfig(plan, config);
  plan.input.files.find((f) => f.path === plan.input.entry)!.text =
    '* Run plan\n.param VIN=0.9\n.include "circuit.spice"\n.control\nset filetype=ascii\nop\nwrite out.raw\n.endc\n.end\n';
  const deck = readFileSync(
    new URL(
      "../../../fixtures/ngspice-rawfile/divider-op.deck.spi",
      import.meta.url,
    ),
    "utf8",
  );
  project.simulationFolders = [
    plan,
    ...["TT", "FF"].map((name) => {
      const folder = createSimulationFolder({
        id: "folder-" + name.toLowerCase(),
        name,
        profileId: profile.id,
      });
      folder.input.files.find((f) => f.path === folder.input.entry)!.text =
        deck;
      return folder;
    }),
  ];
  const executedDecks: string[] = [];
  await page.route("**/api/simulate", async (route) => {
    const body = route.request().postDataJSON();
    if (body.operation === "capabilities")
      return route.fulfill({ json: ngspiceCapabilities() });
    executedDecks.push(body.preparedDeck);
    return route.fulfill({ json: await completedNgspiceRun(body) });
  });
  await page.goto("/editor");
  await openProjectFile(page, project, "batch.icproj.json");
  await clickNetlistWorkflowCommand(page, "open-analog-simulation");
  const panel = page.getByRole("region", { name: "Analog simulation" });
  const batch = panel.locator(".simulation-batch-menu-popover");

  config.runPlan = {
    mode: "sweep",
    axes: [
      { kind: "variable", variableId: "input-level", values: ["0.89", "0.9"] },
      { kind: "temperature", values: [-20, 0, 25.5] },
    ],
  };
  await editSimulationFile(
    page,
    "experiment.json",
    JSON.stringify(config, null, 2),
  );
  await panel
    .getByRole("treeitem", { name: "Run", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Preview input netlist…" }).click();
  await panel.getByTitle("Batch queue", { exact: true }).click();
  await expect(batch).toContainText("Batch · prepared");
  await expect(panel.getByLabel("Prepare temporary files")).toHaveCount(0);
  await expect(panel.getByRole("tab", { name: /prepared\.cir/ })).toBeVisible();
  expect(executedDecks).toHaveLength(0);
  await panel.getByRole("button", { name: "Run", exact: true }).click();
  await expect(batch).toContainText("Batch · finished");
  expect(executedDecks).toHaveLength(6);
  await panel.locator(".simulation-run-history > summary").click();
  const history = panel.getByRole("region", {
    name: "Project runs",
    exact: true,
  });
  // A finished run's row reads as its outcome.
  await expect(
    history.getByRole("listitem").filter({ hasText: "completed" }),
  ).toHaveCount(6);
  await expect(
    history.getByRole("button", { name: "Open result" }).last(),
  ).toBeEnabled();
  await panel.locator(".simulation-run-history > summary").click();

  // Unsaved drafts of two selected folders run, each as an ordinary run.
  const openEntry = async (name: string, folderId: string) => {
    const folder = panel.getByRole("treeitem", {
      name: `Folder ${name}`,
      exact: true,
    });
    if ((await folder.getAttribute("aria-expanded")) !== "true")
      await panel
        .getByRole("button", { name: `Toggle ${name}`, exact: true })
        .click();
    await panel
      .locator(
        `[role="treeitem"][data-folder-id="${folderId}"][data-file-path="run.cir"]`,
      )
      .click();
    await expect(
      panel.getByRole("button", { name: "Run", exact: true }),
    ).toHaveAttribute("title", `Run ${name} / run.cir`);
  };
  for (const name of ["TT", "FF"]) {
    await openEntry(name, `folder-${name.toLowerCase()}`);
    await editSimulationFile(
      page,
      "run.cir",
      deck.replace("divider", `divider ${name} draft`),
    );
  }
  await panel.getByRole("treeitem", { name: "Folder TT", exact: true }).click();
  await panel
    .getByRole("treeitem", { name: "Folder FF", exact: true })
    .click({ modifiers: ["ControlOrMeta"] });
  await panel
    .getByRole("treeitem", { name: "Folder FF", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Run selected folders (2)" })
    .click();
  if (!(await batch.isVisible()))
    await panel.getByTitle("Batch queue", { exact: true }).click();
  await expect(
    batch.getByRole("button", { name: /TT finished/ }),
  ).toBeEnabled();
  await expect(
    batch.getByRole("button", { name: /FF finished/ }),
  ).toBeEnabled();
  expect(executedDecks).toHaveLength(8);
  expect(executedDecks.some((text) => text.includes("TT draft"))).toBe(true);
  expect(executedDecks.some((text) => text.includes("FF draft"))).toBe(true);
  await batch.getByRole("button", { name: /FF finished/ }).click();
  await expect(
    panel.getByRole("button", { name: "Run", exact: true }),
  ).toHaveAttribute("title", "Run FF / run.cir");
  await expect(panel.getByRole("status").first()).toContainText(
    "Batch finished",
  );
});
