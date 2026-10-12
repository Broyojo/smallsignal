import { test, expect } from "@playwright/test";
import { createSimulationFolder } from "@icm/model";
import { readFileSync } from "node:fs";
import { parseProject } from "@icm/project-protocol";
import {
  nativeSimulationDevices,
  type NativeModelLibrarySymbols,
} from "@icm/netlist";
import {
  abortRunsOffering,
  chooseHelperEntry,
  openSimulation,
  ota,
  sourceEditor,
} from "./simulation-e2e-fixtures.js";

test("Profile-backed OP picker discovers an implicit library without writing its generated include", async ({
  page,
}) => {
  const project = parseProject(JSON.stringify(ota));
  const { library }: { library: NativeModelLibrarySymbols } = JSON.parse(
    readFileSync(
      new URL(
        "../../../netlists/vacask-sky130/model-symbols-tt.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const profile = {
    id: "test",
    corners: [],
    modelSymbols: [library],
    dependencies: [{ id: library.dependencyId, sha256: library.sha256 }],
  };
  const folder = createSimulationFolder({
    id: "profile-probes",
    name: "Profile probes",
    profileId: profile.id,
    documentId: project.topDocumentId,
  });
  project.simulationFolders = [folder];
  // Browser authoring proof only. The separate real-runtime OTA test validates
  // these captured model paths against the actual dependency and native process.
  const executions = await abortRunsOffering(page, {
    configured: true,
    rawfileCollection: "native-multi-ascii",
    inputs: ["source"],
    profiles: [
      { ...profile, modelLibrary: { dependencyId: library.dependencyId } },
    ],
    analyses: ["op", "ac"],
    parsedAnalyses: ["op", "ac"],
    maxTimeoutMs: 30000,
    maxInputBytes: 1048576,
    cancel: true,
  });
  await openSimulation(page, project, "profile-probes.icproj.json");
  await chooseHelperEntry(page, "Save device operating point…");
  const picker = page.getByRole("dialog", { name: "Save signal" });
  const device = nativeSimulationDevices(project, folder.input).find(
    (d) => d.instanceId === "M1",
  )!;
  const master = library.masters.find((m) => m.name === device.card.target)!;
  const reference = [device.reference, ...master.primitives[0]!.path].join(":");
  const gm = { reference, save: `p('${reference}',gm)` };
  const choice = picker.getByRole("button", {
    name: `${gm.reference} · gm (model-native) — ${gm.save}`,
  });
  await choice.click();
  await expect(choice).toContainText("Added");
  const editor = sourceEditor(page);
  await expect(editor).toContainText(gm.save);
  await expect(editor).not.toContainText("icm-models");
  await expect(picker.getByRole("status")).toHaveCount(0);
  await picker.getByRole("button", { name: "Done", exact: true }).click();
  await chooseHelperEntry(page, "Save terminal current…");
  const current = picker.getByRole("button", { name: /M1\.D current/ });
  await current.click();
  await expect(current).toContainText("Added");
  const sense = device.currentSenses.find(
    (s) => s.pinName === "D" || s.pinName === "d",
  )!;
  await expect(editor).toContainText(sense.save);
  await expect(editor).not.toContainText(".probe");
  expect(executions()).toBe(0);
});
