// The Gallery entry, projects and route mocks the Gallery specs share.

import type { BrowserContext, Page, Route } from "@playwright/test";
import { createRoutePath, createEmptyProject } from "@icm/model";
import { serializeProject } from "@icm/project-protocol";

export const ENTRY = {
  id: "g-ring",
  name: "Ring Oscillator",
  author: "tz",
  description: "Three-stage loop",
  createdAt: "2026-08-21T10:00:00.000Z",
  previewRevision: "revision-0",
  previewWidth: 640,
  previewHeight: 360,
  schemaVersion: 23,
};

/** Match the list path with or without filters and a paging cursor. */
export const galleryListUrl = (url: URL): boolean =>
  url.pathname === "/api/gallery";

/** A signed-in account as `/api/auth/me` describes it. */
export function sessionUser<Overrides extends object>(
  overrides: Overrides = {} as Overrides,
) {
  return {
    id: "u1",
    displayName: "Member",
    email: "member@example.com",
    provider: "github",
    role: "user",
    isAdmin: false,
    ...overrides,
  };
}

/** Answer the session with this account, or signed out for null. */
export async function signIn(
  target: Page | BrowserContext,
  user: object | null,
): Promise<void> {
  await target.route("**/api/auth/me", (route) =>
    route.fulfill({ json: { user } }),
  );
}

/** One blank drawing for any preview a route answers. */
export function fulfillPreview(route: Route): Promise<void> {
  return route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 6"><rect width="10" height="6" fill="#fff"/></svg>',
  });
}

/** Answer every Gallery, version and Shelf preview with a blank drawing. */
export async function mockPreviews(
  target: Page | BrowserContext,
): Promise<void> {
  await target.route("**/preview.svg*", fulfillPreview);
}

export function galleryResistorProject(value = "1k", count = 2) {
  const project = createEmptyProject(`gallery-${value}-${count}`, "Resistors");
  const document = project.documents[0]!;
  document.instances = Array.from({ length: count }, (_, index) => ({
    id: `R${index + 1}`,
    reference: `R${index + 1}`,
    symbolId: "resistor",
    placement: {
      position: { x: 120 + index * 140, y: 120 },
      rotation: 0 as const,
      mirror: "none" as const,
    },
    netlist: {
      binding: { kind: "primitive" as const, deviceClass: "resistor" as const },
      parameters: { value },
    },
  }));
  document.nets = ["1", "2"].map((pinName) => ({
    id: pinName,
    terminals: document.instances.map(({ id }) => ({
      instanceId: id,
      pinName,
    })),
  }));
  if (count > 1)
    document.routes = ["1", "2"].map((pinName) =>
      createRoutePath({
        id: `rail-${pinName}`,
        netId: pinName,
        start: { kind: "terminal", instanceId: "R1", pinName },
        end: { kind: "terminal", instanceId: `R${count}`, pinName },
        bends: [],
        modes: ["manual"],
      }),
    );
  return project;
}

export async function mockGallery(
  page: Page,
  entries: object[],
): Promise<void> {
  await page.route(galleryListUrl, (route) =>
    route.fulfill({ json: { entries, nextCursor: null } }),
  );
  await page.route(`**/api/gallery/${ENTRY.id}/preview.svg*`, fulfillPreview);
  await page.route(`**/api/gallery/${ENTRY.id}`, (route) =>
    route.fulfill({
      json: {
        entry: ENTRY,
        projectText: serializeProject(
          createEmptyProject("gallery-ring", ENTRY.name),
        ),
      },
    }),
  );
}
