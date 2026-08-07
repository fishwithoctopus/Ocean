import type { SchedulerAdapter } from "./contracts";
import type { FreeTimeConfig } from "../domain/freeTime";
import { OceanGatewayClient } from "../api/OceanGatewayClient";

export class GatewaySchedulerAdapter implements SchedulerAdapter {
  private readonly client: OceanGatewayClient;

  constructor(baseUrl: string) {
    this.client = new OceanGatewayClient(baseUrl || undefined);
  }

  async pause() {
    const config = await this.client.getFreeTimeConfig();
    await this.client.saveFreeTimeConfig({ ...config, paused: true });
  }

  async resume() {
    const config = await this.client.getFreeTimeConfig();
    await this.client.saveFreeTimeConfig({ ...config, paused: false });
  }

  async getStatus() {
    try {
      const config = await this.client.getFreeTimeConfig();
      return config.paused ? "paused" as const : "running" as const;
    } catch {
      return "unavailable" as const;
    }
  }

  getConfig() { return this.client.getFreeTimeConfig(); }
  getCapabilities() { return this.client.capabilities(); }
  updateConfig(config: FreeTimeConfig) { return this.client.saveFreeTimeConfig(config); }
  previewPrompt(config?: FreeTimeConfig) { return this.client.previewFreeTimePrompt(config); }
  triggerNow() { return this.client.triggerFreeTime(); }
  listRuns() { return this.client.listFreeTimeRuns(); }
}

export const gatewaySchedulerAdapter = new GatewaySchedulerAdapter("");
