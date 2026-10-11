// Version history: restoring and comparing Gallery versions, branching from
// them, and a Shelf save history. What a comparison reports, a branch's
// identity and an unavailable snapshot are the gallery-version-diff tests.

import { expect, test } from "./gallery-test.js";
import {
  serializeProject,
  parseProject,
  CURRENT_PROJECT_FILE_VERSION,
} from "@icm/project-protocol";
import { awaitEditorReady } from "./editor-fixtures.js";
import {
  ENTRY,
  fulfillPreview,
  galleryResistorProject,
  mockGallery,
  mockPreviews,
  sessionUser,
  signIn,
} from "./gallery-fixtures.js";

test("Gallery history opens centred, compares apart from the live editor, branches without an update offer and restores", async ({
  page,
}) => {
  const before = galleryResistorProject("1k", 3);
  const after = structuredClone(before);
  const document = after.documents[0]!;
  document.instances[0]!.netlist!.parameters.value = "2k";
  document.instances[2]!.id = "R4";
  document.instances[2]!.reference = "R4";
  document.instances[2]!.placement!.position.x += 40;
  for (const net of document.nets)
    for (const terminal of net.terminals)
      if (terminal.instanceId === "R3") terminal.instanceId = "R4";
  document.routes = [];
  await mockGallery(page, [ENTRY]);
  await mockPreviews(page);
  await signIn(page, sessionUser({ displayName: "Reviewer", isAdmin: true }));
  await page.route(`**/api/gallery/${ENTRY.id}`, (route) =>
    route.fulfill({
      json: { entry: ENTRY, projectText: serializeProject(after) },
    }),
  );
  await page.route(`**/api/gallery/${ENTRY.id}/versions`, (route) =>
    route.fulfill({
      json: {
        versions: [
          {
            versionId: "v1",
            versionNo: 1,
            name: "Resistors",
            author: "tz",
            tags: [],
            createdAt: "2026-09-20T00:00:00.000Z",
          },
        ],
      },
    }),
  );
  await page.route(`**/api/gallery/${ENTRY.id}/versions/v1/project`, (route) =>
    route.fulfill({ json: { projectText: serializeProject(before) } }),
  );
  await page.route(`**/api/gallery/${ENTRY.id}/versions/v1/restore`, (route) =>
    route.fulfill({ json: { id: ENTRY.id, restored: true } }),
  );
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      ["PUT", "POST", "DELETE"].includes(request.method()) &&
      new URL(request.url()).pathname.startsWith("/api/gallery/")
    )
      writes.push(request.url());
  });
  await page.goto(`/g/${ENTRY.id}`);
  await awaitEditorReady(page);
  await expect(page.getByTestId("status")).toContainText(
    `Opened gallery circuit: ${ENTRY.name}`,
  );
  await page.getByTestId("hit-R1").click();
  await page.getByTestId("publish-gallery-button").click();
  await page.getByTestId("publish-history").click();
  const history = page.getByTestId("version-history-dialog");
  const backdropBox = (await page
    .locator(".version-history-backdrop")
    .boundingBox())!;
  const historyBox = (await history.boundingBox())!;
  // Loading this lazy dialog must not drop it into normal editor flow. The
  // overlay owns the viewport and keeps the workbench vertically centered.
  expect(
    Math.abs(
      historyBox.y -
        backdropBox.y -
        (backdropBox.y + backdropBox.height - historyBox.y - historyBox.height),
    ),
  ).toBeLessThanOrEqual(2);
  await page.getByTestId("version-compare-1").click();
  await expect(page.getByTestId("version-comparison")).toContainText(
    "1 added · 1 removed · 2 modified",
  );
  await expect(page.getByTestId("version-highlight-before")).toHaveCount(3);
  await expect(page.getByTestId("version-highlight-after")).toHaveCount(3);
  await page
    .locator('[data-testid="version-highlight-after"][data-instance-id="R1"]')
    .click();
  const details = page.getByRole("table", { name: "R1 changes" });
  await expect(details).toContainText("netlist.parameters.value");
  await expect(details).toContainText("1k");
  await expect(details).toContainText("2k");
  // Keys pressed in the comparison never reach the live editor's selection.
  await page.keyboard.press("Delete");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("active-instance-count")).toHaveText("3");
  // In a narrow window the two sides stack and nothing overflows.
  await page.setViewportSize({ width: 640, height: 800 });
  const sides = page.locator(".version-compare-side");
  const beforeSide = (await sides.first().boundingBox())!;
  const afterSide = (await sides.last().boundingBox())!;
  expect(afterSide.y).toBeGreaterThanOrEqual(beforeSide.y + beforeSide.height);
  expect(
    await history.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  // A branch is a new, unpublished Project in its own tab.
  await page.getByTestId("version-branch-1").click();
  await expect(history).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.getByRole("tab").nth(1)).toContainText("branch v1");
  await expect(page.getByTestId("active-instance-count")).toHaveText("3");
  await page.getByTestId("publish-gallery-button").click();
  await expect(page.getByTestId("publish-history")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Update entry", exact: true }),
  ).toHaveCount(0);
  expect(writes).toEqual([]);

  // Back on the entry's own tab, a version is restored on the server.
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page.getByRole("tab").first().click();
  await page.getByTestId("publish-gallery-button").click();
  await page.getByTestId("publish-history").click();
  await page.getByTestId("version-restore-1").click();
  await awaitEditorReady(page);
  await expect(page.getByTestId("status")).toContainText(
    `Opened gallery circuit: ${ENTRY.name}`,
  );
  expect(writes).toEqual([
    expect.stringContaining(`/api/gallery/${ENTRY.id}/versions/v1/restore`),
  ]);
});

test("Shelf save history compares, branches privately and restores with the listed revision", async ({
  page,
}) => {
  const before = galleryResistorProject("1k");
  const after = galleryResistorProject("2k");
  const summary = {
    id: "draft",
    name: "Private amplifier",
    revision: 4,
    updatedAt: "2026-09-21T08:00:00Z",
    schemaVersion: CURRENT_PROJECT_FILE_VERSION,
  };
  let branch: { projectText: string; galleryEntryId?: string } | undefined;
  let restored = false;
  await signIn(page, sessionUser({ id: "owner", displayName: "Author" }));
  await mockGallery(page, []);
  await page.route("**/api/projects**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path.endsWith("/preview.svg")) return fulfillPreview(route);
    if (path.endsWith("/restore")) {
      expect(req.headers()["if-match"]).toBe("revision-4");
      restored = true;
      return route.fulfill({ json: { project: { ...summary, revision: 5 } } });
    }
    if (path.endsWith("/versions"))
      return route.fulfill({
        json: {
          revision: 4,
          versions: [
            {
              versionId: "draft:3",
              versionNo: 3,
              name: "Earlier amplifier",
              author: "",
              tags: [],
              createdAt: summary.updatedAt,
            },
          ],
        },
      });
    if (path.endsWith("/project"))
      return route.fulfill({ json: { projectText: serializeProject(before) } });
    if (req.method() === "POST") {
      branch = req.postDataJSON();
      return route.fulfill({
        status: 201,
        json: { project: { ...summary, id: "branch", revision: 1 } },
      });
    }
    return route.fulfill({
      json:
        path === "/api/projects"
          ? { projects: [summary] }
          : { project: { ...summary, projectText: serializeProject(after) } },
    });
  });
  await page.goto("/?view=shelf");
  const openHistory = async () => {
    await page.getByTestId("shelf-actions-draft").click();
    await page.getByRole("menuitem", { name: "Version history" }).click();
    await expect(page.getByTestId("version-history-dialog")).toContainText(
      "current draft kept separately",
    );
  };
  await openHistory();
  await page.getByTestId("version-compare-3").click();
  await expect(page.getByTestId("version-comparison")).toContainText(
    "2 modified",
  );
  await page.getByTestId("version-branch-3").click();
  await expect(page.getByTestId("version-history-dialog")).toHaveCount(0);
  expect(branch?.galleryEntryId).toBeUndefined();
  expect(parseProject(branch!.projectText).id).not.toBe(before.id);
  await openHistory();
  await page.getByTestId("version-restore-3").click();
  await expect(page.getByTestId("version-history-dialog")).toHaveCount(0);
  expect(restored).toBe(true);
});
