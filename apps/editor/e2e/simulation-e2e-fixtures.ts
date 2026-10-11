import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import {
  createSimulationEnvironmentMetadata,
  createSimulationInputMetadata,
  readSimulationData,
} from "@icm/spice-run";

export const profile = JSON.parse(
  readFileSync(
    new URL(
      "../../../containers/ngspice/hosted-sky130-profile.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  id: string;
  displayName: string;
  simulator: { version: string };
  models: {
    id: string;
    contentSha256: string;
    library: { runtimePath: string };
  };
  /** The devices the worker advertises, which a new folder's default reads. */
  qualifiedScope: { devices: string[] };
};

export const ota = JSON.parse(
  readFileSync(
    new URL(
      "../../../netlists/native-ota-library/legacy-source.icproj.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

/** ngspice's captured OP of a two-resistor divider (`v(mid)` = 0.5 V). */
export const dividerOpRawfile = readFileSync(
  new URL("../../../fixtures/ngspice-rawfile/divider-op.raw", import.meta.url),
  "utf8",
);

/**
 * The capabilities a configured service advertises: one ngspice Profile with
 * the hosted SKY130 identity, running the given analyses.
 */
export function ngspiceCapabilities(analyses: string[] = ["op"]) {
  return {
    configured: true,
    rawfileCollection: "declared-single-ascii",
    maxOutputBytes: 1048576,
    inputs: ["structured", "raw"],
    analyses,
    parsedAnalyses: analyses,
    profiles: [
      {
        id: profile.id,
        corners: ["tt"],
        dependencies: [
          { id: profile.models.id, sha256: profile.models.contentSha256 },
        ],
      },
    ],
    maxTimeoutMs: 120000,
    maxInputBytes: 1048576,
    cancel: true,
  };
}

/**
 * The simulation service's answer to one execution request: a completed run
 * that returns the captured divider OP rawfile. Only the simulator is a fixture.
 */
export async function completedNgspiceRun(body: {
  preparedDeck: string;
  inputRevision: string;
  netlist: string;
  testbench: string;
}) {
  const rawfile = dividerOpRawfile;
  const reading = readSimulationData(rawfile);
  if (reading.status !== "read") throw Error("Invalid rawfile fixture");
  return {
    outcome: { status: "completed" },
    diagnostics: [],
    log: "ngspice OP",
    durationMs: 1,
    data: reading.data,
    rawfile,
    executedDeck: body.preparedDeck,
    cancelled: false,
    metadata: {
      schemaVersion: 1,
      input: await createSimulationInputMetadata({
        inputRevision: body.inputRevision,
        netlist: body.netlist,
        testbench: body.testbench,
        deck: body.preparedDeck,
      }),
      configuration: { modelLibrary: null },
      environment: await createSimulationEnvironmentMetadata({
        executor: "local-host",
        reproducibility: "observed",
        profileId: profile.id,
        platform: "linux/x64",
        simulator: {
          name: "ngspice",
          version: profile.simulator.version,
          binarySha256: null,
        },
        models: null,
        startupSha256: null,
      }),
    },
  };
}

export async function editSimulationFile(
  page: Page,
  path: string,
  text: string,
) {
  const panel = page.getByRole("region", { name: "Analog simulation" });
  if (path === "experiment.json") {
    if (
      (await panel
        .getByRole("button", { name: "Explorer", exact: true })
        .getAttribute("aria-expanded")) !== "true"
    )
      await panel
        .getByRole("button", { name: "Explorer", exact: true })
        .click();
    const folderId = await panel
      .getByRole("treeitem", { name: "Run", exact: true })
      .getAttribute("data-folder-id");
    await panel
      .getByRole("treeitem", { name: "experiment.json", exact: true })
      .and(panel.locator(`[data-folder-id="${folderId}"]`))
      .click();
  } else await panel.getByRole("tab", { name: path, exact: false }).click();
  const editor = panel.getByRole("textbox", {
    name: "Simulation source editor",
  });
  await expect(editor).toBeVisible();
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText(text);
}
