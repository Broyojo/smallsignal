import { browserExportDelivery } from "../hosts/browser-export-delivery";
import type { EditorServices } from "./editor-services";
import { createProjectSnapshotSerializer } from "../document/project-snapshot-serializer";

/**
 * A static host (GitHub Pages) has no backend: no identity, Cloud Projects,
 * Gallery, Agent relay or simulation service. Work stays in the browser's
 * own workspace recovery and in exported `.icproj.json` files.
 */
export function createStaticEditorServices(): EditorServices {
  return {
    projectSerializer: createProjectSnapshotSerializer(),
    identity: null,
    projectStore: null,
    exportDelivery: browserExportDelivery,
    capabilities: {
      community: false,
      agent: false,
      simulation: false,
      externalLinks: true,
    },
  } satisfies EditorServices;
}
