import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { AgentSessionEvent, PluginContext } from "@paperclipai/plugin-sdk";
import type {
  ChatThread,
  ChatMessage,
  ChatStreamEvent,
  ChatAdapterInfo,
} from "./types.js";

const PLUGIN_NAME = "paperclip-chat";

// ---------------------------------------------------------------------------
// Agent stdout parser
// ---------------------------------------------------------------------------

const ANSI_ESCAPE_REGEX = /\u001B\[[0-?]*[ -/]*[@-~]/g;

function normalizePlainTextLine(line: string): string | null {
  const cleaned = line.replace(ANSI_ESCAPE_REGEX, "").replace(/\r/g, "").trim();
  if (!cleaned) return null;
  if (
    cleaned.startsWith("[paperclip]") ||
    cleaned.startsWith("[hermes] Starting") ||
    cleaned.startsWith("[hermes] Exit code") ||
    cleaned.startsWith("[hermes] Session:") ||
    cleaned.startsWith("session_id:") ||
    cleaned.startsWith("╭─ ⚕ Hermes") ||
    cleaned === "│" ||
    cleaned === "╰──────────────────────────────────────────────────────────────────────────────╯"
  ) {
    return null;
  }
  return cleaned;
}

/**
 * Buffers raw stdout chunks and emits parsed ChatStreamEvents for each
 * complete line from structured adapters (Claude/Codex) or plain-text
 * adapters like Hermes.
 */
function createStreamJsonParser(emit: (event: ChatStreamEvent) => void) {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      // Keep the last (possibly incomplete) line in the buffer
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as Record<string, unknown>;
          const type = obj.type as string | undefined;

          // ── Claude CLI stream-json format ──────────────────────────
          // The CLI emits: system (init), assistant (full message),
          // user (tool_result), and result (final summary).
          if (type === "assistant") {
            const message = obj.message as Record<string, unknown> | undefined;
            const content = Array.isArray(message?.content) ? message!.content : [];
            for (const blockRaw of content) {
              if (typeof blockRaw !== "object" || blockRaw === null || Array.isArray(blockRaw)) continue;
              const block = blockRaw as Record<string, unknown>;
              const blockType = block.type as string | undefined;
              if (blockType === "text" && typeof block.text === "string") {
                emit({ type: "text", text: block.text });
              } else if (blockType === "thinking" && typeof block.thinking === "string") {
                emit({ type: "thinking", text: block.thinking });
              } else if (blockType === "tool_use") {
                emit({
                  type: "tool_use",
                  name: (block.name as string) ?? "tool",
                  input: block.input,
                });
              }
            }
          } else if (type === "user") {
            // Tool results come back as user messages with tool_result blocks
            const message = obj.message as Record<string, unknown> | undefined;
            const content = Array.isArray(message?.content) ? message!.content : [];
            for (const blockRaw of content) {
              if (typeof blockRaw !== "object" || blockRaw === null || Array.isArray(blockRaw)) continue;
              const block = blockRaw as Record<string, unknown>;
              if ((block.type as string) === "tool_result") {
                let resultContent = "";
                if (typeof block.content === "string") {
                  resultContent = block.content;
                } else if (Array.isArray(block.content)) {
                  resultContent = block.content
                    .map((p: unknown) => {
                      if (typeof p === "string") return p;
                      if (typeof p === "object" && p !== null && (p as Record<string, unknown>).type === "text") {
                        return (p as Record<string, unknown>).text as string;
                      }
                      return "";
                    })
                    .filter(Boolean)
                    .join("\n");
                }
                emit({
                  type: "tool_result",
                  content: resultContent,
                  isError: block.is_error === true,
                });
              }
            }
          } else if (type === "system" && obj.subtype === "init") {
            if (typeof obj.session_id === "string") {
              emit({ type: "session_init", sessionId: obj.session_id });
            }
          } else if (type === "result") {
            const usage = obj.usage as Record<string, unknown> | undefined;
            emit({
              type: "result",
              usage: usage ? {
                input_tokens: (usage.input_tokens as number) ?? 0,
                output_tokens: (usage.output_tokens as number) ?? 0,
              } : undefined,
              costUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd
                : typeof obj.cost_usd === "number" ? obj.cost_usd
                : undefined,
            });
          }

          // ── Codex CLI stream-json format ───────────────────────────
          // Local Codex agents emit turn/item NDJSON events instead of
          // Anthropic-style block deltas.
          if (type === "item.started" || type === "item.completed") {
            const item = obj.item as Record<string, unknown> | undefined;
            const itemType = item?.type as string | undefined;

            if (itemType === "agent_message" && type === "item.completed" && typeof item?.text === "string") {
              emit({ type: "text", text: item.text });
            }

            if (itemType === "command_execution") {
              const command = typeof item?.command === "string" ? item.command : "command";

              if (type === "item.started") {
                emit({
                  type: "tool_use",
                  name: "command",
                  input: { command },
                });
              }

              if (type === "item.completed") {
                const aggregatedOutput = typeof item?.aggregated_output === "string" ? item.aggregated_output : "";
                const exitCode = typeof item?.exit_code === "number" ? item.exit_code : null;
                const status = typeof item?.status === "string" ? item.status : "completed";
                const summary = aggregatedOutput.trim() || `Command ${status}${exitCode !== null ? ` (exit ${exitCode})` : ""}`;
                emit({
                  type: "tool_result",
                  content: summary,
                  isError: exitCode !== null ? exitCode !== 0 : status === "failed",
                });
              }
            }
          }

          if (type === "turn.completed") {
            const usage = obj.usage as Record<string, unknown> | undefined;
            emit({
              type: "result",
              usage: usage ? {
                input_tokens: (usage.input_tokens as number) ?? 0,
                output_tokens: (usage.output_tokens as number) ?? 0,
              } : undefined,
            });
          }

          if (type === "turn.failed" && typeof obj.error === "string") {
            emit({ type: "error", text: obj.error });
          }

          // ── Anthropic API streaming format (fallback) ──────────────
          // In case the adapter emits raw API events instead of CLI format.
          if (type === "content_block_delta") {
            const delta = obj.delta as Record<string, unknown> | undefined;
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              emit({ type: "text", text: delta.text });
            }
            if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
              emit({ type: "thinking", text: delta.thinking });
            }
          }
        } catch {
          const plainText = normalizePlainTextLine(line);
          if (plainText) {
            emit({ type: "text", text: `${plainText}\n` });
          }
        }
      }
    },
    /** Flush any remaining buffer content */
    flush() {
      if (buffer.trim()) {
        this.push("\n");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// State key helpers — all chat data lives in plugin.state
// ---------------------------------------------------------------------------

function threadListKey(companyId: string) {
  return `threads:${companyId}`;
}

function threadKey(threadId: string) {
  return `thread:${threadId}`;
}

function messagesKey(threadId: string) {
  return `messages:${threadId}`;
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

async function getThread(ctx: PluginContext, threadId: string): Promise<ChatThread | null> {
  const raw = await ctx.state.get({
    scopeKind: "instance",
    scopeId: "global",
    stateKey: threadKey(threadId),
  });
  return (raw as ChatThread) ?? null;
}

async function saveThread(ctx: PluginContext, thread: ChatThread): Promise<void> {
  await ctx.state.set({
    scopeKind: "instance",
    scopeId: "global",
    stateKey: threadKey(thread.id),
  }, thread as unknown);
}

async function getThreadList(ctx: PluginContext, companyId: string): Promise<string[]> {
  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: threadListKey(companyId),
  });
  return (raw as string[]) ?? [];
}

async function saveThreadList(ctx: PluginContext, companyId: string, ids: string[]): Promise<void> {
  await ctx.state.set({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: threadListKey(companyId),
  }, ids as unknown);
}

async function getMessages(ctx: PluginContext, threadId: string): Promise<ChatMessage[]> {
  const raw = await ctx.state.get({
    scopeKind: "instance",
    scopeId: "global",
    stateKey: messagesKey(threadId),
  });
  return (raw as ChatMessage[]) ?? [];
}

async function saveMessages(ctx: PluginContext, threadId: string, msgs: ChatMessage[]): Promise<void> {
  await ctx.state.set({
    scopeKind: "instance",
    scopeId: "global",
    stateKey: messagesKey(threadId),
  }, msgs as unknown);
}

function generateId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Adapter type → human-readable label
// ---------------------------------------------------------------------------

const ADAPTER_LABELS: Record<string, string> = {
  hermes_local: "Hermes",
  claude_local: "Claude",
  openai: "OpenAI",
  codex: "Codex",
  opencode: "OpenCode",
};

function adapterTypeLabel(adapterType: string): string {
  return ADAPTER_LABELS[adapterType] ?? adapterType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_NAME} plugin setup`);

    // ── Data: list threads ──────────────────────────────────────────
    ctx.data.register("threads", async (params: Record<string, unknown>) => {
      const companyId = params.companyId as string;
      if (!companyId) return [];
      const ids = await getThreadList(ctx, companyId);
      const threads: ChatThread[] = [];
      for (const id of ids) {
        const thread = await getThread(ctx, id);
        if (thread) threads.push(thread);
      }
      // Sort by updatedAt descending
      threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return threads;
    });

    // ── Data: get messages for a thread ─────────────────────────────
    ctx.data.register("messages", async (params: Record<string, unknown>) => {
      const threadId = params.threadId as string;
      if (!threadId) return [];
      return getMessages(ctx, threadId);
    });

    // ── Data: list available adapters ───────────────────────────────
    ctx.data.register("adapters", async (params: Record<string, unknown>) => {
      const companyId = params.companyId as string;
      if (!companyId) {
        return [
          { type: "hermes_local", label: "Hermes", available: true, models: [] },
        ] as ChatAdapterInfo[];
      }
      try {
        const agents = await ctx.agents.list({ companyId });

        // Deduplicate by adapterType — show distinct adapter types, not individual agents
        // Mark available if ANY agent of that type is not terminated
        const adapterMap = new Map<string, ChatAdapterInfo>();
        for (const a of agents) {
          const existing = adapterMap.get(a.adapterType);
          if (existing) {
            // If any agent of this type is available, mark the adapter available
            if (a.status !== "terminated") existing.available = true;
            continue;
          }
          adapterMap.set(a.adapterType, {
            type: a.adapterType,
            label: adapterTypeLabel(a.adapterType),
            available: a.status !== "terminated",
            models: [],
          });
        }
        const adapters = Array.from(adapterMap.values());
        return adapters.length > 0 ? adapters : [
          { type: "hermes_local", label: "Hermes", available: true, models: [] },
        ];
      } catch {
        return [
          { type: "hermes_local", label: "Hermes", available: true, models: [] },
        ] as ChatAdapterInfo[];
      }
    });

    // ── Action: create thread ───────────────────────────────────────
    ctx.actions.register("createThread", async (params: Record<string, unknown>) => {
      const companyId = params.companyId as string;
      const adapterType = (params.adapterType as string) ?? "hermes_local";
      const model = (params.model as string) ?? "";
      const title = (params.title as string) ?? "New Chat";
      if (!companyId) throw new Error("companyId is required");

      const thread: ChatThread = {
        id: generateId(),
        companyId,
        title,
        sessionId: null,
        adapterType,
        model,
        status: "idle",
        createdBy: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await saveThread(ctx, thread);
      const ids = await getThreadList(ctx, companyId);
      ids.unshift(thread.id);
      await saveThreadList(ctx, companyId, ids);

      return thread;
    });

    // ── Action: delete thread ───────────────────────────────────────
    ctx.actions.register("deleteThread", async (params: Record<string, unknown>) => {
      const threadId = params.threadId as string;
      const companyId = params.companyId as string;
      if (!threadId || !companyId) throw new Error("threadId and companyId required");

      // Remove from thread list
      const ids = await getThreadList(ctx, companyId);
      const filtered = ids.filter((id) => id !== threadId);
      await saveThreadList(ctx, companyId, filtered);

      // Delete thread and messages state
      await ctx.state.delete({
        scopeKind: "instance",
        scopeId: "global",
        stateKey: threadKey(threadId),
      });
      await ctx.state.delete({
        scopeKind: "instance",
        scopeId: "global",
        stateKey: messagesKey(threadId),
      });

      return { ok: true };
    });

    // ── Action: update thread title ─────────────────────────────────
    ctx.actions.register("updateThreadTitle", async (params: Record<string, unknown>) => {
      const threadId = params.threadId as string;
      const title = params.title as string;
      if (!threadId || !title) throw new Error("threadId and title required");

      const thread = await getThread(ctx, threadId);
      if (!thread) throw new Error("Thread not found");

      thread.title = title;
      thread.updatedAt = new Date().toISOString();
      await saveThread(ctx, thread);
      return thread;
    });

    // ── Action: send message (starts streaming) ─────────────────────
    ctx.actions.register("sendMessage", async (params: Record<string, unknown>) => {
      const threadId = params.threadId as string;
      const message = params.message as string;
      const companyId = params.companyId as string;
      if (!threadId || !message || !companyId) {
        throw new Error("threadId, message, and companyId required");
      }

      const thread = await getThread(ctx, threadId);
      if (!thread) throw new Error("Thread not found");

      const streamChannel = `chat:${threadId}`;
      let streamOpened = false;

      try {
        // Save user message
        const msgs = await getMessages(ctx, threadId);
        const userMsg: ChatMessage = {
          id: generateId(),
          threadId,
          role: "user",
          content: message,
          metadata: null,
          createdAt: new Date().toISOString(),
        };
        msgs.push(userMsg);
        await saveMessages(ctx, threadId, msgs);

        // Mark thread as running
        thread.status = "running";
        thread.updatedAt = new Date().toISOString();

        // Auto-generate title from first user message
        if (thread.title === "New Chat") {
          const shortTitle = message.length > 60
            ? message.slice(0, 57).replace(/\s+\S*$/, "") + "..."
            : message;
          const titleLine = shortTitle.split("\n")[0] ?? shortTitle;
          thread.title = titleLine;
        }
        await saveThread(ctx, thread);

        // Track whether this is the first message in the thread (new session)
        const isNewSession = !thread.sessionId;

        // Create or resume agent session
        let sessionId = thread.sessionId;
        if (!sessionId) {
          // Look up a chat-suitable agent by adapter type.
          // If the stored adapter no longer exists, fall back to the first live adapter
          // so old/broken drafts can still recover.
          const agents = await ctx.agents.list({ companyId });
          let matching = agents.filter((a) => a.adapterType === thread.adapterType && a.status !== "terminated");
          if (matching.length === 0) {
            const fallbackAgent = agents.find((a) => a.status !== "terminated");
            if (fallbackAgent) {
              thread.adapterType = fallbackAgent.adapterType;
              thread.updatedAt = new Date().toISOString();
              await saveThread(ctx, thread);
              matching = agents.filter((a) => a.adapterType === thread.adapterType && a.status !== "terminated");
            }
          }
          const agent = matching.find((a) => a.name === "Chat Assistant") ?? matching.find((a) => a.role === "general") ?? matching[0];
          if (!agent) {
            throw new Error(`No agent found with adapter type "${thread.adapterType}". Available: ${agents.map((a) => `${a.name}(${a.adapterType})`).join(", ") || "none"}`);
          }
          const session = await ctx.agents.sessions.create(agent.id, companyId, {
            reason: "Chat plugin: new conversation",
          });
          sessionId = session.sessionId;
          thread.sessionId = sessionId;
          await saveThread(ctx, thread);
        }

        // Keep the user prompt verbatim. Injecting a roster of agents into the
        // first turn makes simple questions read like orchestration tasks and
        // leads to vague replies instead of direct answers.
        const enrichedMessage = message;

        // Open SSE stream channel for this thread so the UI gets real-time events
        ctx.streams.open(streamChannel, companyId);
        streamOpened = true;

        // Collect response segments for persistence
        const segments: ChatMessage["metadata"] = { segments: [] };
        let fullResponse = "";

        if (thread.title !== "New Chat") {
          ctx.streams.emit(streamChannel, { type: "title_updated", title: thread.title });
        }

        const RUN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
        let runId: string | undefined;

        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error("Chat response timed out"));
          }, RUN_TIMEOUT_MS);

          const handleParsedEvent = (chatEvent: ChatStreamEvent) => {
            if (chatEvent.type === "text" && chatEvent.text) {
              fullResponse += chatEvent.text;
              const last = segments.segments[segments.segments.length - 1];
              if (last && last.kind === "text") {
                last.content += chatEvent.text;
              } else {
                segments.segments.push({ kind: "text", content: chatEvent.text });
              }
            }
            if (chatEvent.type === "thinking" && chatEvent.text) {
              const last = segments.segments[segments.segments.length - 1];
              if (last && last.kind === "thinking") {
                last.content += chatEvent.text;
              } else {
                segments.segments.push({ kind: "thinking", content: chatEvent.text });
              }
            }
            if (chatEvent.type === "tool_use") {
              segments.segments.push({
                kind: "tool",
                name: chatEvent.name ?? "tool",
                input: chatEvent.input,
              });
            }
            if (chatEvent.type === "tool_result") {
              for (let i = segments.segments.length - 1; i >= 0; i--) {
                const seg = segments.segments[i];
                if (seg && seg.kind === "tool" && seg.result === undefined) {
                  seg.result = chatEvent.content ?? "";
                  seg.isError = chatEvent.isError ?? false;
                  break;
                }
              }
            }
            if (chatEvent.type === "session_init" && chatEvent.sessionId) {
              thread.sessionId = chatEvent.sessionId;
            }

            if (chatEvent.type === "result" || chatEvent.type === "error") {
              clearTimeout(timer);
              resolve();
            }

            ctx.streams.emit(streamChannel, chatEvent);
          };

          const parser = createStreamJsonParser(handleParsedEvent);

          ctx.agents.sessions.sendMessage(sessionId, companyId, {
            prompt: enrichedMessage,
            reason: "Chat plugin: user message",
            onEvent: (event: AgentSessionEvent) => {
              if (event.eventType === "chunk") {
                const stream = event.stream ?? (event.payload?.stream as string | undefined);
                if (stream === "stdout" && event.message) {
                  parser.push(event.message);
                }
                return;
              }

              if (event.eventType === "done") {
                parser.flush();
                handleParsedEvent({
                  type: "result",
                  usage: event.payload?.usage as ChatStreamEvent["usage"],
                  costUsd: event.payload?.costUsd as number | undefined,
                });
                return;
              }
              if (event.eventType === "error") {
                parser.flush();
                handleParsedEvent({ type: "error", text: event.message ?? "Unknown error" });
                return;
              }
              if (event.eventType === "status" && event.payload?.sessionId) {
                handleParsedEvent({ type: "session_init", sessionId: event.payload.sessionId as string });
              }
            },
          }).then((result) => {
            runId = result.runId;
          }).catch((err) => {
            clearTimeout(timer);
            reject(err);
          });
        });

        if (fullResponse || segments.segments.length > 0) {
          const assistantMsg: ChatMessage = {
            id: generateId(),
            threadId,
            role: "assistant",
            content: fullResponse,
            metadata: segments,
            createdAt: new Date().toISOString(),
          };
          const updatedMsgs = await getMessages(ctx, threadId);
          updatedMsgs.push(assistantMsg);
          await saveMessages(ctx, threadId, updatedMsgs);
        }

        thread.status = "idle";
        thread.updatedAt = new Date().toISOString();
        await saveThread(ctx, thread);

        ctx.streams.emit(streamChannel, { type: "done" });
        ctx.streams.close(streamChannel);

        ctx.logger.info(`Chat message completed`, { threadId, runId });

        return { ok: true, runId };
      } catch (err) {
        thread.status = "idle";
        thread.updatedAt = new Date().toISOString();
        await saveThread(ctx, thread).catch(() => {});

        const errorText = err instanceof Error ? err.message : String(err);
        if (streamOpened) {
          ctx.streams.emit(streamChannel, { type: "error", text: errorText });
          ctx.streams.emit(streamChannel, { type: "done" });
          ctx.streams.close(streamChannel);
        }
        ctx.logger.error("Chat message failed", { threadId, error: errorText });
        throw err;
      }
    });

    // ── Action: stop a running response ─────────────────────────────
    ctx.actions.register("stopThread", async (params: Record<string, unknown>) => {
      const threadId = params.threadId as string;
      const companyId = params.companyId as string;
      if (!threadId || !companyId) throw new Error("threadId and companyId required");

      const thread = await getThread(ctx, threadId);
      if (!thread || !thread.sessionId) return { ok: true, stopped: false };

      await ctx.agents.sessions.close(thread.sessionId, companyId);
      thread.status = "idle";
      thread.sessionId = null; // Force new session on next message
      thread.updatedAt = new Date().toISOString();
      await saveThread(ctx, thread);

      return { ok: true, stopped: true };
    });
  },

  async onHealth() {
    return { status: "ok", message: `${PLUGIN_NAME} ready` };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
