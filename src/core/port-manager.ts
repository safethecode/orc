import type { PortAllocation } from "../config/types.ts";
import type { Store } from "../db/store.ts";
import { createConnection } from "node:net";

const DEFAULT_PORT_RANGE: [number, number] = [10000, 10999];

export class PortManager {
  private rangeStart: number;
  private rangeEnd: number;

  constructor(
    private store: Store,
    range?: [number, number],
  ) {
    this.rangeStart = range?.[0] ?? DEFAULT_PORT_RANGE[0];
    this.rangeEnd = range?.[1] ?? DEFAULT_PORT_RANGE[1];
  }

  async allocate(agentName: string, taskId: string, purpose: string): Promise<number> {
    const allocated = this.store.getAllocatedPorts();
    const usedPorts = new Set(allocated.map((a) => a.port));

    for (let port = this.rangeStart; port <= this.rangeEnd; port++) {
      if (usedPorts.has(port)) continue;

      // Check if port is actually available on the system
      const available = await this.isPortAvailable(port);
      if (!available) continue;

      const success = this.store.allocatePort(port, agentName, taskId, purpose);
      if (success) return port;
    }

    throw new Error(`No available ports in range ${this.rangeStart}-${this.rangeEnd}`);
  }

  release(port: number): void {
    this.store.releasePort(port);
  }

  releaseByAgent(agentName: string): void {
    this.store.releasePortsByAgent(agentName);
  }

  getAllocations(): PortAllocation[] {
    return this.store.getAllocatedPorts();
  }

  getAgentPorts(agentName: string): PortAllocation[] {
    return this.store.getAllocatedPorts().filter((a) => a.agentName === agentName);
  }

  isAllocated(port: number): boolean {
    return this.store.isPortAllocated(port);
  }

  async cleanup(): Promise<number> {
    // Release ports that are no longer in use (process died)
    const allocations = this.store.getAllocatedPorts();
    let cleaned = 0;

    for (const alloc of allocations) {
      const inUse = await this.isPortInUse(alloc.port);
      if (!inUse) {
        this.store.releasePort(alloc.port);
        cleaned++;
      }
    }

    return cleaned;
  }

  getAvailableCount(): number {
    const allocated = this.store.getAllocatedPorts().length;
    return this.rangeEnd - this.rangeStart + 1 - allocated;
  }

  private isPortAvailable(port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const server = Bun.listen({
        hostname: "127.0.0.1",
        port,
        socket: {
          data() {},
          open() {},
          close() {},
          error() {},
        },
      });
      try {
        server.stop();
        resolve(true);
      } catch {
        resolve(false);
      }
    }).catch((): Promise<boolean> => {
      // Fallback: try TCP connect
      return new Promise<boolean>((resolve) => {
        const socket = createConnection({ port, host: "127.0.0.1" });
        socket.on("connect", () => { socket.destroy(); resolve(false); });
        socket.on("error", () => { socket.destroy(); resolve(true); });
        socket.setTimeout(500, () => { socket.destroy(); resolve(true); });
      });
    });
  }

  private isPortInUse(port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const socket = createConnection({ port, host: "127.0.0.1" });
      socket.on("connect", () => { socket.destroy(); resolve(true); });
      socket.on("error", () => { socket.destroy(); resolve(false); });
      socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
    });
  }
}
