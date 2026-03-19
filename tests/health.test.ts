import { describe, it, expect, beforeAll, afterAll } from "bun:test";

describe("/health endpoint", () => {
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/health") {
          return Response.json({ status: "ok", uptime: process.uptime() });
        }
        return new Response("Not Found", { status: 404 });
      },
    });
  });

  afterAll(() => {
    server.stop();
  });

  it("returns 200 with status ok and numeric uptime", async () => {
    const res = await fetch(`http://localhost:${server.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; uptime: number };
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it("returns correct Content-Type header", async () => {
    const res = await fetch(`http://localhost:${server.port}/health`);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("returns 404 for unknown routes", async () => {
    const res = await fetch(`http://localhost:${server.port}/unknown`);
    expect(res.status).toBe(404);
  });
});
