import { once } from "node:events";
import { createServer } from "node:http";
import { mergeReasoningDetails, OpenAICompatibleAdapter } from "./openaiCompatible.js";
import { openAIChatMessages } from "./streaming.js";
import type { GatewayStreamEvent, ProviderDefinition } from "./types.js";

const bodies: Array<Record<string, any>> = [];

const visualMessages = openAIChatMessages({
  input: "describe the image",
  attachments: [{ kind: "image", name: "fixture.png", mimeType: "image/png", size: 3, data: "data:image/png;base64,AAA=" }],
}, "fixture system");
const visualContent = visualMessages.at(-1)?.content;
if (!Array.isArray(visualContent)
  || visualContent[0]?.type !== "text"
  || visualContent[1]?.type !== "image_url"
  || visualContent[1]?.image_url?.url !== "data:image/png;base64,AAA=") {
  throw new Error("Visual attachment was not forwarded as a direct image input");
}

const mergedReasoning: unknown[] = [];
mergeReasoningDetails(mergedReasoning, [{
  type: "reasoning.text",
  id: "reasoning-1",
  index: 0,
  text: "first ",
  signature: "signed-",
}]);
mergeReasoningDetails(mergedReasoning, [{
  type: "reasoning.text",
  id: "reasoning-1",
  index: 0,
  text: "second",
  signature: "continuation",
}]);
const reconstructedReasoning = mergedReasoning[0] as Record<string, unknown>;
if (mergedReasoning.length !== 1
  || reconstructedReasoning.text !== "first second"
  || reconstructedReasoning.signature !== "signed-continuation") {
  throw new Error("Streaming reasoning_details were not reconstructed before a tool continuation");
}
const fixture = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>;
  bodies.push(body);
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const hasToolResult = body.messages?.some((message: Record<string, unknown>) => message.role === "tool");
  if (!hasToolResult) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_details: [{ type: "reasoning.summary", summary: "先确认写入目标，再调用长期记忆工具。" }, { type: "reasoning.text", text: "fixture" }] } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "ocean_memory_hold", arguments: "{\"content\":\"Ocean test\"}" } }] } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`);
  } else {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "已保存。" } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 14, completion_tokens: 3 } })}\n\n`);
  }
  response.write("data: [DONE]\n\n");
  response.end();
});
fixture.listen(0, "127.0.0.1");
await once(fixture, "listening");
const address = fixture.address();
if (!address || typeof address === "string") throw new Error("OpenRouter smoke fixture failed to bind");

const provider: ProviderDefinition = {
  id: "openrouter",
  name: "OpenRouter",
  kind: "openai-compatible",
  baseUrl: `http://127.0.0.1:${address.port}`,
  apiKey: "fixture-key",
  defaultModel: "anthropic/claude-opus-4.6",
  capabilities: ["stream", "reasoning", "tools"],
  models: [],
};
const adapter = new OpenAICompatibleAdapter(provider, "fixture system");
const events: GatewayStreamEvent[] = [];
let executed = 0;
for await (const event of adapter.stream({
  input: "请记住 Ocean test",
  settings: { reasoning: "high" },
  tools: [{
    type: "function",
    function: {
      name: "ocean_memory_hold",
      description: "Save memory",
      parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
    },
  }],
  toolChoice: { type: "function", function: { name: "ocean_memory_hold" } },
  executeTool: async (name, argumentsValue) => {
    executed += 1;
    return { ok: name === "ocean_memory_hold" && argumentsValue.content === "Ocean test", content: { saved: true, bucketId: "bucket-fixture" } };
  },
}, "anthropic/claude-opus-4.6")) events.push(event);

const first = bodies[0];
const cacheBreakpointTexts = (body: Record<string, any>) => (body.messages ?? []).flatMap((message: Record<string, any>) => {
  if (!Array.isArray(message.content)) return [];
  return message.content
    .filter((part: Record<string, any>) => part?.cache_control?.type === "ephemeral")
    .map((part: Record<string, any>) => String(part.text ?? ""));
});
if (first?.reasoning?.effort !== "high" || first?.reasoning?.exclude !== false) throw new Error("OpenRouter reasoning object was not sent");
if (!Array.isArray(first?.tools) || first.tools[0]?.function?.name !== "ocean_memory_hold") throw new Error("OpenRouter tools field was not sent");
if (first?.tool_choice?.function?.name !== "ocean_memory_hold") throw new Error("Explicit memory save did not force the hold tool");
const firstBreakpoints = cacheBreakpointTexts(first);
if (firstBreakpoints.length !== 1) throw new Error("OpenRouter cache breakpoint was not sent");
if (bodies.length !== 1 || executed !== 1) throw new Error("A forced write must execute once without a signed-reasoning continuation");
const reasoningEvent = events.find((event) => event.type === "reasoning");
const savedSegment = events.find((event) => event.type === "segment");
if (!reasoningEvent || !reasoningEvent.value.content.includes("先确认写入目标") || !savedSegment || !savedSegment.value.includes("bucket-fixture") || savedSegment.value === "已保存。") throw new Error("Verified tool result did not replace untrusted provider prose");

fixture.close();
console.log(JSON.stringify({ ok: true, requests: bodies.length, executed, events: events.map((event) => event.type) }));
