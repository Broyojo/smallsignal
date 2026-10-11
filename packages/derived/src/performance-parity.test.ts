import { InMemorySymbolResolver, builtInSymbols } from "@icm/symbols";
import { describe, expect, it } from "vitest";

import {
  buildProjectConnectivityIndex,
  deriveNetConnectivity,
  deriveNetConnectivityContext,
} from "./index.js";
import { diagnoseVisualQuality } from "./visual.js";
import {
  createLargePerformanceFixture,
  LARGE_PERFORMANCE_FIXTURE_COUNTS,
} from "./test-support/large-performance-fixture.js";

const resolver = new InMemorySymbolResolver(builtInSymbols);
// The legacy oracles walk every route for every Net, so the parity checks use
// a smaller document of the same shape: equivalence does not depend on size,
// and the timing at full size belongs to the browser benchmark.
const parityCounts = {
  instances: 100,
  nets: 70,
  routes: 220,
  junctions: 90,
  annotations: 100,
};

describe("large deterministic derived fixture", () => {
  it("is reproducible at the current large-project scale", () => {
    const first = createLargePerformanceFixture(resolver);
    const second = createLargePerformanceFixture(resolver);
    const document = first.documents[0]!;

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect({
      instances: document.instances.length,
      nets: document.nets.length,
      routes: document.routes.length,
      junctions: document.junctions.length,
      annotations: document.annotations.length,
    }).toEqual(LARGE_PERFORMANCE_FIXTURE_COUNTS);
  });

  it("keeps shared-context Connectivity byte-for-byte equivalent", () => {
    const project = createLargePerformanceFixture(resolver, parityCounts);
    const document = project.documents[0]!;
    const legacy = [...document.nets]
      .sort((left, right) => left.id.localeCompare(right.id, "en"))
      .map((net) => deriveNetConnectivity(document, resolver, net));
    const context = deriveNetConnectivityContext(document, resolver);
    const shared = [...document.nets]
      .sort((left, right) => left.id.localeCompare(right.id, "en"))
      .map((net) => deriveNetConnectivity(document, resolver, net, context));

    expect(shared).toStrictEqual(legacy);
    const indexed = buildProjectConnectivityIndex(
      project,
      resolver,
    ).documents.get(document.id)!;
    expect(indexed.spatialIndex.routeSegments.size).toBeGreaterThanOrEqual(
      document.routes.length,
    );
  }, 20_000);

  it("keeps indexed Diagnostics field-for-field equivalent", () => {
    const legacyDocument = createLargePerformanceFixture(resolver, parityCounts)
      .documents[0]!;
    const indexedDocument = createLargePerformanceFixture(
      resolver,
      parityCounts,
    ).documents[0]!;

    const legacy = diagnoseVisualQuality(legacyDocument, resolver, {
      candidateSearch: "legacy",
    });
    const indexed = diagnoseVisualQuality(indexedDocument, resolver, {
      candidateSearch: "indexed",
    });

    expect(indexed).toStrictEqual(legacy);
  }, 20_000);
});
