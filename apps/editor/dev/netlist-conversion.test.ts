import { createServer } from "node:http";
import { expect, it } from "vitest";
import { localNetlistConversion } from "./netlist-conversion.js";

it("serves the conversion protocol from the preview server and passes other paths on", async () => {
  let middleware: any;
  const plugin = localNetlistConversion();
  (plugin.configurePreviewServer as Function)({
    middlewares: {
      use(fn: any) {
        middleware = fn;
      },
    },
  });
  const server = createServer((req, res) =>
    middleware(req, res, () => res.writeHead(404).end()),
  );
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const convert = async (text: string, source: string, target: string) =>
    (
      await fetch(`${base}/api/netlist/convert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, source, target }),
      })
    ).json();
  try {
    const spectre = await convert("R1 a 0 1Meg", "spice", "spectre");
    expect(spectre.text).toContain("resistor r=1000000");
    const back = await convert(spectre.text, "spectre", "ngspice");
    expect(back.text).toContain("R1 a 0 1000000");
    expect((await fetch(`${base}/api/other`)).status).toBe(404);
  } finally {
    server.close();
  }
});
