import type { ChatAdapter } from "./contracts";
import type { ChatContext, ChatStreamEvent } from "../domain/ocean";
import { getGatewayBaseUrl } from "../config/gateway";

export class GatewayChatAdapter implements ChatAdapter {
  constructor(private readonly baseUrl?: string) {}
  async *streamReply(input: string, context: ChatContext): AsyncIterable<ChatStreamEvent> {
    const baseUrl = this.baseUrl ?? getGatewayBaseUrl();
    const attachments = context.attachments?.map(({ previewDataUrl: _previewDataUrl, ...attachment }) => attachment);
    const response = await fetch(`${baseUrl}/v1/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input, context, messages: context.messages, attachments, providerId: context.providerId, modelId: context.modelId, settings: context.settings }) });
    if (!response.ok || !response.body) throw new Error(`Gateway stream failed: ${response.status}`);
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
    while (true) {
      const { value, done } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) {
        const event = JSON.parse(line) as ChatStreamEvent;
        if (event.type === "error") throw new Error(event.message);
        yield event;
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const event = JSON.parse(buffer) as ChatStreamEvent;
      if (event.type === "error") throw new Error(event.message);
      yield event;
    }
  }
}

export const gatewayChatAdapter = new GatewayChatAdapter();
