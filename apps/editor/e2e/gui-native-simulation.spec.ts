import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { parseProject } from "@icm/project-protocol";
import { createSimulationFolder } from "@icm/model";
import { exportedProject, openProjectFile } from "./editor-fixtures.js";
import {
  agentNativeProfile,
  agentNativeSource,
  createAgentNativeExecutor,
} from "./native-simulation-executor.mjs";

// The GUI's one end-to-end native run: replayed VACASK records by default,
// the real executable with ICM_E2E_VACASK_REAL=1.
test("GUI shows unruled VACASK measurements and opens their Console evidence", async ({
  page,
}) => {
  const project = parseProject(
    await readFile(
      "apps/editor/src/examples/simulation-rc.icproj.json",
      "utf8",
    ),
  );
  const folder = createSimulationFolder({
    id: "native-specs",
    name: "Native measurements",
    profileId: agentNativeProfile,
  });
  folder.input.entry = "run.sim";
  folder.input.circuitBindings = [];
  folder.input.files = [
    {
      path: "experiment.json",
      text: JSON.stringify({
        version: 2,
        environment: { profileId: agentNativeProfile },
      }),
    },
    { path: "run.sim", text: agentNativeSource },
  ];
  project.simulationFolders = [folder];
  const executor = await createAgentNativeExecutor();
  try {
    await page.route("**/api/simulate", async (route) => {
      const input = route.request().postDataJSON();
      if (input.operation === "capabilities")
        return route.fulfill({ json: executor.capabilities });
      const result = await executor.execute(input);
      // Only the external process report is scripted; the Editor, service,
      // collector, artifact materialization and navigation are real.
      result.log +=
        '\nICM_MEASUREMENT_V1 {"name":"native_gain","status":"available","value":2,"unit":"V"}';
      return route.fulfill({ json: result });
    });
    await page.goto("/editor");
    await openProjectFile(page, project, "native-specs.icproj.json");
    await page.getByTestId("open-analog-simulation").click();
    const panel = page.getByRole("region", { name: "Analog simulation" });
    await panel.getByRole("button", { name: "Run", exact: true }).click();
    await expect(panel.getByRole("status")).toHaveText("completed");
    await panel.getByRole("tab", { name: "Specs", exact: true }).click();
    await panel.locator(".simulation-spec-other summary").click();
    const measurement = panel.getByRole("button", {
      name: "native_gain",
      exact: true,
    });
    await expect(measurement).toHaveAttribute("title", /log\.txt:/);
    await expect(panel.locator(".simulation-spec-other")).toContainText(
      "Measured only",
    );
    await measurement.click();
    await expect(
      panel.getByRole("tab", { name: "Console", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(panel.locator(".simulation-console-view")).toContainText(
      '"name":"native_gain"',
    );
    await expect(panel).not.toContainText("earlier source snapshot");
  } finally {
    await executor.close();
  }
});

// Offline, with no Profile advertised, a new experiment takes the native
// candidate and its VACASK starter. Choosing an advertised environment is
// simulation-workspace's "a new experiment takes the environment the Agent
// would"; each engine's starter text is simulation-starter.test.ts.
test("GUI creates an offline experiment with the VACASK candidate identity", async ({
  page,
}) => {
  const project = parseProject(
    await readFile(
      "apps/editor/src/examples/simulation-rc.icproj.json",
      "utf8",
    ),
  );
  project.simulationFolders = [];
  await page.route("**/api/simulate", (route) =>
    route.fulfill({
      json: {
        configured: false,
        rawfileCollection: "native-multi-ascii",
        inputs: ["source"],
        analyses: ["op"],
        parsedAnalyses: ["op"],
        profiles: [],
        maxTimeoutMs: 15000,
        maxInputBytes: 1048576,
        cancel: true,
      },
    }),
  );
  await page.goto("/editor");
  await openProjectFile(page, project, "no-experiments.icproj.json");
  await page.getByTestId("open-analog-simulation").click();
  const panel = page.getByRole("region", { name: "Analog simulation" });
  await panel
    .getByRole("button", { name: "Set up manually", exact: true })
    .click();
  const name = panel.getByRole("textbox", {
    name: "New simulation folder name",
  });
  await name.fill("Native first experiment");
  await name.press("Enter");
  await expect(
    panel.getByRole("treeitem", {
      name: "Folder Native first experiment",
      exact: true,
    }),
  ).toBeVisible();
  const saved: ReturnType<typeof parseProject> = await exportedProject(page);
  const folder = saved.simulationFolders[0]!;
  const config = JSON.parse(
    folder.input.files.find((f) => f.path === folder.input.configPath)!.text,
  );
  expect(config).toEqual({
    version: 2,
    environment: { profileId: "vacask-sky130-candidate" },
  });
  const entry = folder.input.files.find(
    (f) => f.path === folder.input.entry,
  )!.text;
  expect(entry).toContain("analysis op op");
  expect(entry).not.toContain(".control");
});
