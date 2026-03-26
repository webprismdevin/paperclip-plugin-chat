import type { PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { usePluginData, usePluginAction, useHostContext, usePluginStream } from "@paperclipai/plugin-sdk/ui";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ChatThread,
  ChatMessage,
  ChatSegment,
  ChatAdapterInfo,
  ChatStreamEvent,
} from "../types.js";

// ---------------------------------------------------------------------------
// SVG Icons — match core chat UI icons
// ---------------------------------------------------------------------------

function IconChat({ size = 16, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

function IconSend({ size = 16, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

function IconSidebar({ size = 16, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

function IconPlus({ size = 16, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function IconUser({ size = 16, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function IconStop({ size = 16, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function IconChevron({ size = 10, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Utility hooks — dark mode, mobile, available height
// ---------------------------------------------------------------------------

function useIsDarkMode(): boolean {
  const [isDarkMode, setIsDarkMode] = useState(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const update = () => setIsDarkMode(root.classList.contains("dark"));
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return isDarkMode;
}

function useIsMobile(breakpointPx = 768): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < breakpointPx : false,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mediaQuery = window.matchMedia(`(max-width: ${breakpointPx - 1}px)`);
    const update = () => setIsMobile(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, [breakpointPx]);
  return isMobile;
}

function useAvailableHeight(
  ref: React.RefObject<HTMLElement | null>,
  options?: { bottomPadding?: number; minHeight?: number },
): number | null {
  const bottomPadding = options?.bottomPadding ?? 24;
  const minHeight = options?.minHeight ?? 384;
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => {
      const element = ref.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const nextHeight = Math.max(minHeight, Math.floor(window.innerHeight - rect.top - bottomPadding));
      setHeight(nextHeight);
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => update()) : null;
    if (observer && ref.current) observer.observe(ref.current);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      observer?.disconnect();
    };
  }, [bottomPadding, minHeight, ref]);
  return height;
}

// ---------------------------------------------------------------------------
// Markdown link component — open links in new tab
// ---------------------------------------------------------------------------

const mdComponents: Record<string, React.ComponentType<any>> = {
  a: ({ href, children, ...props }: any) => (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
  ),
};

// ---------------------------------------------------------------------------
// CHAT_STYLES — CSS animations, markdown prose, scrollbar styling
// ---------------------------------------------------------------------------

const CHAT_STYLES = `
  .chat-msg-enter {
    animation: chatMsgSlide 380ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  @keyframes chatMsgSlide {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .chat-cursor::after {
    content: "\\25CA";
    display: inline;
    animation: cursorBlink 800ms steps(2) infinite;
    color: var(--primary, #2563eb);
    font-weight: 400;
    margin-left: 1px;
  }
  @keyframes cursorBlink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }
  .chat-tool-pulse {
    animation: toolPulse 1.8s ease-in-out infinite;
  }
  @keyframes toolPulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }
  .chat-input-glow:focus-within {
    border-color: var(--primary, #2563eb) !important;
    box-shadow: 0 0 0 1px rgba(37, 99, 235, 0.15);
  }
  .chat-markdown h1, .chat-markdown h2, .chat-markdown h3 {
    font-weight: 600;
    margin-top: 1em;
    margin-bottom: 0.4em;
    line-height: 1.3;
  }
  .chat-markdown h1 { font-size: 1.15em; }
  .chat-markdown h2 { font-size: 1.05em; }
  .chat-markdown h3 { font-size: 0.95em; }
  .chat-markdown p { margin: 0.4em 0; }
  .chat-markdown ul, .chat-markdown ol { margin: 0.4em 0; padding-left: 1.5em; }
  .chat-markdown ul { list-style-type: disc; }
  .chat-markdown ol { list-style-type: decimal; }
  .chat-markdown li { margin: 0.15em 0; }
  .chat-markdown li::marker { color: rgba(100, 116, 139, 0.6); }
  .chat-markdown code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.88em;
    padding: 0.15em 0.35em;
    border-radius: 3px;
    background: var(--code-bg, rgba(0, 0, 0, 0.08));
  }
  .chat-markdown pre {
    margin: 0.6em 0;
    padding: 0.75em 1em;
    border-radius: 6px;
    overflow-x: auto;
    background: var(--code-block-bg, rgba(0, 0, 0, 0.06)) !important;
    border: 1px solid var(--border, rgba(0, 0, 0, 0.1));
  }
  .chat-markdown pre code {
    padding: 0;
    background: none;
    font-size: 0.85em;
    line-height: 1.5;
  }
  .chat-markdown a {
    color: var(--primary, #2563eb);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .chat-markdown blockquote {
    border-left: 2px solid var(--border, rgba(0, 0, 0, 0.15));
    padding-left: 0.75em;
    margin: 0.5em 0;
    color: var(--muted-foreground, rgba(100, 116, 139, 0.8));
  }
  .chat-markdown table {
    border-collapse: collapse;
    margin: 0.5em 0;
    font-size: 0.9em;
  }
  .chat-markdown th, .chat-markdown td {
    border: 1px solid var(--border, rgba(0, 0, 0, 0.1));
    padding: 0.35em 0.6em;
    text-align: left;
  }
  .chat-markdown th {
    background: var(--accent, rgba(0, 0, 0, 0.06));
    font-weight: 600;
  }
  .chat-scroll::-webkit-scrollbar { width: 4px; }
  .chat-scroll::-webkit-scrollbar-track { background: transparent; }
  .chat-scroll::-webkit-scrollbar-thumb {
    background: rgba(100, 116, 139, 0.3);
    border-radius: 2px;
  }
  .chat-scroll::-webkit-scrollbar-thumb:hover { background: rgba(100, 116, 139, 0.5); }
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .chat-msg-enter { animation: none; }
    .chat-cursor::after { animation: none; }
    .chat-tool-pulse { animation: none; opacity: 1; }
  }
`;

// ---------------------------------------------------------------------------
// Segment grouping — collapses consecutive tool/thinking segments
// ---------------------------------------------------------------------------

type GroupedSegment =
  | { type: "text"; content: string; index: number }
  | { type: "error"; content: string; index: number }
  | { type: "activity"; segments: ChatSegment[]; startIndex: number };

function groupSegments(segments: ChatSegment[]): GroupedSegment[] {
  const groups: GroupedSegment[] = [];
  let activityBuf: ChatSegment[] = [];
  let activityStart = 0;

  const flushActivity = () => {
    if (activityBuf.length > 0) {
      groups.push({ type: "activity", segments: [...activityBuf], startIndex: activityStart });
      activityBuf = [];
    }
  };

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.kind === "tool" || seg.kind === "thinking") {
      if (activityBuf.length === 0) activityStart = i;
      activityBuf.push(seg);
    } else if (seg.kind === "text") {
      flushActivity();
      groups.push({ type: "text", content: seg.content, index: i });
    }
  }
  flushActivity();
  return groups;
}

function summarizeTools(segments: ChatSegment[]): string {
  const tools = segments.filter((s) => s.kind === "tool");
  if (tools.length === 0) return "Thinking";
  const counts = new Map<string, number>();
  for (const t of tools) {
    if (t.kind === "tool") counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [name, count] of counts) {
    parts.push(count > 1 ? `${name} \u00d7${count}` : name);
  }
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Sub-components — ThinkingBlock, ToolCallDetail, ActivityGroup
// ---------------------------------------------------------------------------

function ThinkingBlock({ content, isLive }: { content: string; isLive: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="chat-msg-enter my-1.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground bg-transparent border-none cursor-pointer p-0 opacity-60"
      >
        <span className="text-[10px]">{expanded ? "\u25BC" : "\u25B6"}</span>
        <span>{isLive ? "Thinking\u2026" : "Thought process"}</span>
        {isLive && <span className="chat-tool-pulse text-primary">{"\u25CF"}</span>}
      </button>
      {expanded && (
        <div className="mt-1 pl-5 text-xs text-muted-foreground opacity-50 leading-relaxed whitespace-pre-wrap border-l-2 border-border ml-1.5">
          {content}
        </div>
      )}
    </div>
  );
}

function ToolCallDetail({ seg, isLive }: { seg: Extract<ChatSegment, { kind: "tool" }>; isLive: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const hasResult = seg.result !== undefined;
  return (
    <div className="my-0.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-[11px] text-muted-foreground bg-transparent border-none cursor-pointer py-0.5 px-0 font-mono opacity-70"
      >
        <span className="text-[9px]">{expanded ? "\u25BC" : "\u25B6"}</span>
        <span>{seg.name}</span>
        {!hasResult && isLive && <span className="chat-tool-pulse text-[#f59e0b] text-[8px]">{"\u25CF"}</span>}
        {hasResult && seg.isError && <span className="text-[#ef4444] text-[10px]">{"\u2715"}</span>}
        {hasResult && !seg.isError && <span className="text-[#22c55e] text-[10px]">{"\u2713"}</span>}
      </button>
      {expanded && (
        <div className="ml-4 text-[11px] font-mono">
          {seg.input != null && (
            <div className="p-1 px-2 bg-[rgba(0,0,0,0.06)] rounded-sm mb-1 max-h-[100px] overflow-auto text-muted-foreground">
              {typeof seg.input === "string" ? seg.input : JSON.stringify(seg.input, null, 2)}
            </div>
          )}
          {seg.result && (
            <div className={`p-1 px-2 rounded-sm max-h-[120px] overflow-auto ${seg.isError ? "bg-[rgba(239,68,68,0.08)] text-[#ef4444]" : "bg-[rgba(0,0,0,0.04)] text-muted-foreground"}`}>
              {seg.result}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ActivityGroup({ segments, isLive }: { segments: ChatSegment[]; isLive: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const toolCount = segments.filter((s) => s.kind === "tool").length;
  const hasErrors = segments.some((s) => s.kind === "tool" && (s as any).isError);
  const allDone = segments
    .filter((s) => s.kind === "tool")
    .every((s) => (s as any).result !== undefined);
  const activeTool = isLive
    ? segments.filter((s) => s.kind === "tool").reverse().find((s) => (s as any).result === undefined)
    : undefined;

  return (
    <div className="my-0.5 opacity-50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-[11px] text-muted-foreground bg-transparent border-none cursor-pointer py-0.5 px-0 opacity-80"
      >
        <span className="text-[9px]">{expanded ? "\u25BC" : "\u25B6"}</span>
        {isLive && activeTool && activeTool.kind === "tool" ? (
          <span>
            Running <span className="font-mono">{activeTool.name}</span>
            {toolCount > 1 && <span className="opacity-60">{" \u00B7 "}{toolCount} tools</span>}
          </span>
        ) : (
          <span>
            Used {toolCount} tool{toolCount !== 1 ? "s" : ""}
            <span className="opacity-50 ml-1">{summarizeTools(segments)}</span>
          </span>
        )}
        {isLive && !allDone && (
          <span className="chat-tool-pulse text-[#f59e0b] text-[8px]">{"\u25CF"}</span>
        )}
        {!isLive && hasErrors && (
          <span className="text-[rgba(239,68,68,0.5)] text-[10px]">has errors</span>
        )}
      </button>
      {expanded && (
        <div className="ml-4 mt-0.5 border-l border-border pl-2.5">
          {segments.map((seg, i) => {
            if (seg.kind === "tool") {
              return <ToolCallDetail key={i} seg={seg} isLive={isLive} />;
            }
            if (seg.kind === "thinking") {
              return <ThinkingBlock key={i} content={seg.content} isLive={isLive && i === segments.length - 1} />;
            }
            return null;
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// formatTime — absolute time display matching core UI (e.g. "08:22 PM")
// ---------------------------------------------------------------------------

function formatTime(isoStr: string): string {
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// MessageRow — renders a single persisted message
// ---------------------------------------------------------------------------

function MessageRow({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  const storedSegments = msg.metadata?.segments;
  const hasSegments = storedSegments && storedSegments.length > 0;

  return (
    <div className="chat-msg-enter flex gap-3 py-4">
      <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 mt-px ${isUser ? "bg-muted-foreground text-white" : "bg-primary/10 text-primary"}`}>
        {isUser ? <IconUser size={15} /> : <span className="text-[13px] font-bold">P</span>}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 mb-1">
          <span className="text-[13px] font-semibold text-foreground">
            {isUser ? "You" : "Paperclip"}
          </span>
          <span className="text-[11px] text-muted-foreground opacity-60">
            {formatTime(msg.createdAt)}
          </span>
        </div>
        <div className="text-sm text-foreground leading-relaxed">
          {isUser ? (
            <p className="m-0 whitespace-pre-wrap"><IssueLinkedText text={msg.content} /></p>
          ) : hasSegments ? (
            groupSegments(storedSegments).map((group, i) => {
              if (group.type === "text") {
                return (
                  <div key={i} className="chat-markdown">
                    <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>{linkifyIssues(group.content)}</Markdown>
                  </div>
                );
              }
              if (group.type === "activity") {
                return <ActivityGroup key={i} segments={group.segments} isLive={false} />;
              }
              if (group.type === "error") {
                return (
                  <div key={i} className="chat-msg-enter my-1.5 py-2 px-3 rounded-md bg-[rgba(239,68,68,0.08)] border border-[rgba(239,68,68,0.15)] text-[13px] text-[#ef4444] flex items-start gap-2">
                    <span className="shrink-0 mt-px text-xs">!</span>
                    <span className="whitespace-pre-wrap">{group.content}</span>
                  </div>
                );
              }
              return null;
            })
          ) : (
            <div className="chat-markdown">
              <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>{linkifyIssues(msg.content)}</Markdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StreamingMessage — renders the live assistant response
// ---------------------------------------------------------------------------

function StreamingMessage({
  segments,
  streamingText,
  streamingThinking,
  streamingError,
  isActive,
}: {
  segments: ChatSegment[];
  streamingText: string;
  streamingThinking: string;
  streamingError: string;
  isActive: boolean;
}) {
  const allSegments: ChatSegment[] = [...segments];
  if (streamingThinking) {
    allSegments.push({ kind: "thinking", content: streamingThinking });
  }
  if (streamingText) {
    allSegments.push({ kind: "text", content: streamingText });
  }

  const grouped = groupSegments(allSegments);
  const hasAnyContent = allSegments.length > 0;

  let lastTextIdx = -1;
  for (let i = grouped.length - 1; i >= 0; i--) {
    if (grouped[i].type === "text") { lastTextIdx = i; break; }
  }

  return (
    <div className="chat-msg-enter flex gap-3 py-4">
      <div className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 mt-px bg-primary/10 text-primary">
        <span className="text-[13px] font-bold">P</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 mb-1">
          <span className="text-[13px] font-semibold text-foreground">Paperclip</span>
          <span className="text-[11px] text-muted-foreground opacity-60">now</span>
        </div>
        <div className="text-sm text-foreground leading-relaxed">
          {!hasAnyContent && isActive && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="inline-block" style={{ animation: "spin 1s linear infinite" }}>&#x27F3;</span>
              <span className="text-xs">Thinking&#x2026;</span>
            </div>
          )}

          {grouped.map((group, gi) => {
            if (group.type === "text") {
              const isLastText = gi === lastTextIdx && isActive;
              return (
                <div key={gi} className={`chat-markdown ${isLastText ? "chat-cursor" : ""}`}>
                  <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>{linkifyIssues(group.content)}</Markdown>
                </div>
              );
            }
            if (group.type === "activity") {
              return <ActivityGroup key={gi} segments={group.segments} isLive={isActive} />;
            }
            if (group.type === "error") {
              return (
                <div key={gi} className="chat-msg-enter my-1.5 py-2 px-3 rounded-md bg-[rgba(239,68,68,0.08)] border border-[rgba(239,68,68,0.15)] text-[13px] text-[#ef4444] flex items-start gap-2">
                  <span className="shrink-0 mt-px text-xs">!</span>
                  <span className="whitespace-pre-wrap">{group.content}</span>
                </div>
              );
            }
            return null;
          })}
          {streamingError && (
            <div className="chat-msg-enter my-1.5 py-2 px-3 rounded-md bg-[rgba(239,68,68,0.08)] border border-[rgba(239,68,68,0.15)] text-[13px] text-[#ef4444] flex items-start gap-2">
              <span className="shrink-0 mt-px text-xs">!</span>
              <span className="whitespace-pre-wrap">{streamingError}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

interface SlashCommand {
  name: string;
  description: string;
  prompt: string;
}

const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "tasks", description: "List all active tasks", prompt: "Show me all active tasks (todo, in_progress, blocked) in my workspace. Include status, priority, and assignee for each." },
  { name: "dashboard", description: "Show workspace dashboard", prompt: "Show me the company dashboard — health summary, agent status, task counts, and spend." },
  { name: "agents", description: "List all agents and their status", prompt: "List all agents in my workspace with their current status, role, and budget usage." },
  { name: "create", description: "Create a new task", prompt: "Help me create a new task. Ask me for the title, description, priority, and assignee." },
  { name: "projects", description: "List all projects", prompt: "Show me all projects in my workspace with their status and any associated workspaces." },
  { name: "costs", description: "Show cost breakdown", prompt: "Show me the cost summary for my workspace — total spend, breakdown by agent, and by project." },
  { name: "activity", description: "Show recent activity", prompt: "Show me the recent activity log for my workspace." },
  { name: "blocked", description: "Show blocked tasks", prompt: "Show me all blocked tasks and what's blocking them. Include comments explaining the blockers." },
  { name: "plan", description: "Plan and break down work", prompt: "Help me plan work. I'll describe what I need done and you'll help break it into tasks, assign them, and set priorities." },
  { name: "handoff", description: "Hand off work to an agent", prompt: "I want to hand off work to an agent. Which agent should I assign this to, and what's the task? List available agents so I can pick one." },
];

// ---------------------------------------------------------------------------
// Issue reference helpers — auto-detect #PROJ-123 patterns
// ---------------------------------------------------------------------------

function IssueLinkedText({ text }: { text: string }) {
  const parts = text.split(/(#[A-Z][A-Z0-9]*-\d+)/g);
  return (
    <>
      {parts.map((part, i) =>
        /^#[A-Z][A-Z0-9]*-\d+$/.test(part) ? (
          <span key={i} className="text-primary font-medium">
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

function linkifyIssues(text: string): string {
  return text.replace(/(#[A-Z][A-Z0-9]*-\d+)/g, "**$1**");
}

// ---------------------------------------------------------------------------
// Quick action chips for welcome screen
// ---------------------------------------------------------------------------

const QUICK_ACTIONS = [
  { label: "Check in on issues", prompt: "Check in on all active issues — show me status, what's blocked, and what needs attention." },
  { label: "Review goal progress", prompt: "Review progress on all active goals. Summarize where each stands and flag anything off track." },
  { label: "Plan an initiative", prompt: "I want to plan a new initiative. Help me break it down into tasks and assign them to the right agents." },
  { label: "Agent status", prompt: "Show me the status of all agents — who's active, idle, what they're working on, and any budget concerns." },
];

// ---------------------------------------------------------------------------
// ChatInput — unified input container matching core UI
// ---------------------------------------------------------------------------

function ChatInput({
  input,
  setInput,
  onSend,
  onStop,
  onKeyDown,
  isStreaming,
  sending,
  placeholder,
  textareaRef,
  adjustTextareaHeight,
  showSlashMenu,
  filteredCommands,
  slashMenuIndex,
  setSlashMenuIndex,
  selectCommand,
  availableAdapters,
  selectedAdapter,
  setSelectedAdapter,
  selectedThread,
  currentModels,
  selectedModel,
  setSelectedModel,
}: {
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  isStreaming: boolean;
  sending: boolean;
  placeholder: string;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  adjustTextareaHeight: () => void;
  showSlashMenu: boolean;
  filteredCommands: SlashCommand[];
  slashMenuIndex: number;
  setSlashMenuIndex: (i: number) => void;
  selectCommand: (cmd: SlashCommand) => void;
  availableAdapters: ChatAdapterInfo[];
  selectedAdapter: string;
  setSelectedAdapter: (v: string) => void;
  selectedThread: ChatThread | null;
  currentModels: { id: string; label: string }[];
  selectedModel: string;
  setSelectedModel: (v: string) => void;
}) {
  return (
    <div className="relative">
      {showSlashMenu && (
        <div className="absolute bottom-full left-0 right-0 mb-1 bg-card border border-border rounded-lg shadow-lg overflow-hidden z-50">
          <div className="px-3 py-1.5 border-b border-border">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground opacity-60">
              Commands
            </span>
          </div>
          <div className="chat-scroll max-h-60 overflow-y-auto py-1">
            {filteredCommands.map((cmd, i) => (
              <button
                key={cmd.name}
                ref={i === slashMenuIndex ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                onClick={() => selectCommand(cmd)}
                onMouseEnter={() => setSlashMenuIndex(i)}
                className={`w-full text-left py-2 px-3 flex items-center gap-2 border-none text-foreground cursor-pointer text-[13px] transition-colors duration-100 ${i === slashMenuIndex ? "bg-accent" : "bg-transparent"}`}
              >
                <span className="font-semibold text-primary font-mono text-xs">
                  /{cmd.name}
                </span>
                <span className="text-muted-foreground text-xs overflow-hidden text-ellipsis whitespace-nowrap">
                  {cmd.description}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Unified input container */}
      <div className="chat-input-glow flex items-end border border-border rounded-xl bg-background pl-3 pr-1 py-1 transition-all duration-150">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            adjustTextareaHeight();
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={1}
          className="flex-1 resize-none py-1.5 px-2 border-none text-sm font-[inherit] bg-transparent text-foreground outline-none min-h-[32px] h-[32px] leading-5"
        />
        {isStreaming ? (
          <button
            onClick={onStop}
            className="w-8 h-8 rounded-lg border-none bg-destructive text-white cursor-pointer flex items-center justify-center shrink-0"
            title="Stop"
          >
            <IconStop size={14} />
          </button>
        ) : (
          <button
            onClick={onSend}
            disabled={!input.trim() || sending}
            className={`w-8 h-8 rounded-lg border-none text-white flex items-center justify-center shrink-0 transition-all duration-150 ${input.trim() && !sending ? "bg-primary cursor-pointer opacity-100" : "bg-muted-foreground cursor-not-allowed opacity-30"}`}
            title="Send"
          >
            <IconSend size={14} />
          </button>
        )}
      </div>

      {/* Adapter / model selector row */}
      <div className="flex items-center gap-1 mt-1.5 text-[11px] text-muted-foreground px-1">
        {availableAdapters.length > 0 && (
          <span className={selectedThread ? "cursor-default opacity-50" : "cursor-pointer opacity-70"}>
            {availableAdapters.length > 1 && !selectedThread ? (
              <select
                value={selectedAdapter}
                onChange={(e) => setSelectedAdapter(e.target.value)}
                className="bg-transparent border-none text-[inherit] text-[inherit] cursor-pointer p-0 font-[inherit]"
              >
                {availableAdapters.map((a) => (
                  <option key={a.type} value={a.type}>{a.label}</option>
                ))}
              </select>
            ) : (
              <span>{availableAdapters.find((a) => a.type === selectedAdapter)?.label ?? "Claude"}</span>
            )}
          </span>
        )}
        {currentModels.length > 0 && (
          <>
            <span className="opacity-40">/</span>
            <span className="opacity-70">
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="bg-transparent border-none text-[inherit] text-[inherit] cursor-pointer p-0 font-[inherit]"
              >
                {currentModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </span>
          </>
        )}
        <span className="ml-auto opacity-40">Shift+Enter for new line</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChatPage — full-page chat interface rendered in the plugin page slot
// ---------------------------------------------------------------------------

export function ChatPage(_props: PluginPageProps) {
  const { companyId } = useHostContext();

  // Container ref for useAvailableHeight
  const containerRef = useRef<HTMLDivElement>(null);
  const availableHeight = useAvailableHeight(containerRef, { bottomPadding: 24, minHeight: 384 });

  // Thread state
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [selectedAdapter, setSelectedAdapter] = useState("claude_local");
  const [selectedModel, setSelectedModel] = useState("");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [streamingThinking, setStreamingThinking] = useState("");
  const [streamingError, setStreamingError] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const adjustTextareaHeight = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 144) + "px";
  }, []);

  useEffect(() => {
    adjustTextareaHeight();
  }, [input, adjustTextareaHeight]);

  useEffect(() => {
    if (!confirmDeleteId) return;
    const timer = setTimeout(() => setConfirmDeleteId(null), 3000);
    return () => clearTimeout(timer);
  }, [confirmDeleteId]);

  // Bridge hooks
  const { data: threads, refresh: refreshThreads } = usePluginData<ChatThread[]>("threads", {
    companyId,
  });
  const { data: messages, refresh: refreshMessages } = usePluginData<ChatMessage[]>("messages", {
    threadId: selectedThreadId,
  });
  const { data: adapters } = usePluginData<ChatAdapterInfo[]>("adapters", { companyId });
  const createThread = usePluginAction("createThread");
  const deleteThread = usePluginAction("deleteThread");
  const sendMessage = usePluginAction("sendMessage");
  const stopThread = usePluginAction("stopThread");
  const updateThreadTitle = usePluginAction("updateThreadTitle");

  // SSE stream
  const streamChannel = selectedThreadId ? `chat:${selectedThreadId}` : "";
  const { events: streamEvents, connected: streamConnected } = usePluginStream<ChatStreamEvent>(
    streamChannel,
    { companyId: companyId ?? undefined },
  );

  // Derived state
  const availableAdapters = adapters?.filter((a) => a.available) ?? [];
  const currentAdapter = availableAdapters.find((a) => a.type === selectedAdapter) ?? availableAdapters[0];
  const currentModels = currentAdapter?.models ?? [];
  const selectedThread = threads?.find((t) => t.id === selectedThreadId) ?? null;
  const isStreaming = selectedThread?.status === "running" || sending;

  // Slash command detection
  const slashMatch = input.match(/^\/(\w*)$/);
  const slashQuery = slashMatch ? slashMatch[1].toLowerCase() : null;
  const filteredCommands = slashQuery !== null
    ? BUILTIN_COMMANDS.filter((c) => c.name.startsWith(slashQuery))
    : [];
  const showSlashMenu = slashQuery !== null && filteredCommands.length > 0 && !isStreaming;

  // Process stream events
  const lastProcessedCount = useRef(0);
  useEffect(() => {
    if (streamEvents.length <= lastProcessedCount.current) return;

    const newEvents = streamEvents.slice(lastProcessedCount.current);
    lastProcessedCount.current = streamEvents.length;

    for (const evt of newEvents) {
      if (evt.type === "text" && evt.text) {
        setStreamingText((prev) => prev + evt.text);
      }
      if (evt.type === "thinking" && evt.text) {
        setStreamingThinking((prev) => prev + evt.text);
      }
      if (evt.type === "error" && evt.text) {
        const errText = evt.text;
        setStreamingError((prev) => prev ? prev + "\n" + errText : errText);
      }
      if (evt.type === "title_updated") {
        refreshThreads();
      }
      if (evt.type === "done") {
        refreshMessages();
        refreshThreads();
        setStreamingText("");
        setStreamingThinking("");
        setStreamingError("");
        lastProcessedCount.current = 0;
      }
    }
  }, [streamEvents, refreshMessages, refreshThreads]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  // Lock adapter on existing thread
  useEffect(() => {
    if (selectedThread) {
      setSelectedAdapter(selectedThread.adapterType);
      setSelectedModel(selectedThread.model);
    }
  }, [selectedThread]);

  // Default model
  useEffect(() => {
    if (currentModels.length > 0 && !currentModels.find((m) => m.id === selectedModel)) {
      setSelectedModel(currentModels[0]!.id);
    }
  }, [currentModels, selectedModel]);

  // Reset streaming on thread switch
  useEffect(() => {
    setStreamingText("");
    setStreamingThinking("");
    setStreamingError("");
    lastProcessedCount.current = 0;
  }, [selectedThreadId]);

  // Reset slash menu
  useEffect(() => {
    setSlashMenuIndex(0);
  }, [slashQuery]);

  // ── Handlers ────────────────────────────────────────────────────

  const handleNewThread = useCallback(async () => {
    const thread = await createThread({
      companyId,
      adapterType: selectedAdapter,
      model: selectedModel,
      title: "New Chat",
    }) as ChatThread;
    setSelectedThreadId(thread.id);
    refreshThreads();
  }, [companyId, selectedAdapter, selectedModel, createThread, refreshThreads]);

  const handleDeleteThread = useCallback(async (threadId: string) => {
    await deleteThread({ threadId, companyId });
    if (selectedThreadId === threadId) setSelectedThreadId(null);
    refreshThreads();
  }, [companyId, deleteThread, selectedThreadId, refreshThreads]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || sending) return;

    let threadId = selectedThreadId;

    if (!threadId) {
      const thread = await createThread({
        companyId,
        adapterType: selectedAdapter,
        model: selectedModel,
      }) as ChatThread;
      threadId = thread.id;
      setSelectedThreadId(threadId);
    }

    setSending(true);
    setInput("");
    setStreamingText("");
    setStreamingThinking("");
    setStreamingError("");
    lastProcessedCount.current = 0;

    // Refresh early so the user message appears while the agent is working
    setTimeout(() => { refreshMessages(); refreshThreads(); }, 300);

    try {
      await sendMessage({
        threadId,
        message: trimmed,
        companyId,
      });
    } catch (err) {
      console.error("Send failed:", err);
    } finally {
      setSending(false);
      refreshMessages();
      refreshThreads();
    }
  }, [input, sending, selectedThreadId, companyId, selectedAdapter, selectedModel, createThread, sendMessage, refreshMessages, refreshThreads]);

  const handleStop = useCallback(async () => {
    if (!selectedThreadId) return;
    await stopThread({ threadId: selectedThreadId, companyId });
    refreshThreads();
    setStreamingText("");
    setStreamingThinking("");
    setStreamingError("");
  }, [selectedThreadId, companyId, stopThread, refreshThreads]);

  const selectCommand = useCallback(async (cmd: SlashCommand) => {
    setInput("");
    let threadId = selectedThreadId;
    if (!threadId) {
      const thread = await createThread({
        companyId,
        adapterType: selectedAdapter,
        model: selectedModel,
      }) as ChatThread;
      threadId = thread.id;
      setSelectedThreadId(threadId);
    }
    setSending(true);
    setStreamingText("");
    setStreamingThinking("");
    setStreamingError("");
    lastProcessedCount.current = 0;
    setTimeout(() => { refreshMessages(); refreshThreads(); }, 300);
    try {
      await sendMessage({ threadId, message: cmd.prompt, companyId });
    } catch (err) {
      console.error("Send failed:", err);
    } finally {
      setSending(false);
      refreshMessages();
      refreshThreads();
    }
  }, [selectedThreadId, companyId, selectedAdapter, selectedModel, createThread, sendMessage, refreshMessages, refreshThreads]);

  const handleQuickAction = useCallback(async (prompt: string) => {
    const thread = await createThread({
      companyId,
      adapterType: selectedAdapter,
      model: selectedModel,
    }) as ChatThread;
    setSelectedThreadId(thread.id);
    setSending(true);
    setStreamingText("");
    setStreamingThinking("");
    setStreamingError("");
    lastProcessedCount.current = 0;
    setTimeout(() => { refreshMessages(); refreshThreads(); }, 300);
    try {
      await sendMessage({ threadId: thread.id, message: prompt, companyId });
    } catch (err) {
      console.error("Send failed:", err);
    } finally {
      setSending(false);
      refreshMessages();
      refreshThreads();
    }
  }, [companyId, selectedAdapter, selectedModel, createThread, sendMessage, refreshMessages, refreshThreads]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSlashMenu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashMenuIndex((prev) => (prev + 1) % filteredCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashMenuIndex((prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectCommand(filteredCommands[slashMenuIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setInput("");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend, showSlashMenu, filteredCommands, slashMenuIndex, selectCommand]);

  // ── Render ──────────────────────────────────────────────────────

  const inputProps = {
    input,
    setInput,
    onSend: handleSend,
    onStop: handleStop,
    onKeyDown: handleKeyDown,
    isStreaming,
    sending,
    textareaRef: textareaRef as React.RefObject<HTMLTextAreaElement>,
    adjustTextareaHeight,
    showSlashMenu,
    filteredCommands,
    slashMenuIndex,
    setSlashMenuIndex,
    selectCommand,
    availableAdapters,
    selectedAdapter,
    setSelectedAdapter,
    selectedThread,
    currentModels,
    selectedModel,
    setSelectedModel,
  };

  return (
    <div
      ref={containerRef}
      className="flex font-[system-ui,-apple-system,sans-serif]"
      style={availableHeight ? { height: availableHeight } : { height: "calc(100vh - 8rem)" }}
    >
      <style dangerouslySetInnerHTML={{ __html: CHAT_STYLES }} />

      {/* ── Sidebar ── */}
      <div
        className={`flex flex-col bg-card transition-all duration-200 overflow-hidden shrink-0 ${sidebarCollapsed ? "" : "border-r border-border"}`}
        style={{ width: sidebarCollapsed ? 0 : 220 }}
      >
        {/* New Chat button */}
        <div className="p-3">
          <button
            onClick={() => { setSelectedThreadId(null); setInput(""); }}
            className="w-full py-2 px-3 rounded-lg border border-border bg-transparent text-foreground cursor-pointer text-[13px] font-medium flex items-center justify-center gap-1.5"
          >
            <IconPlus size={14} />
            New Chat
          </button>
        </div>

        {/* Thread list */}
        <div className="chat-scroll flex-1 overflow-auto">
          {threads?.map((thread) => (
            <div
              key={thread.id}
              onClick={() => setSelectedThreadId(thread.id)}
              className={`py-2.5 px-3 cursor-pointer flex items-start gap-2.5 transition-colors duration-100 hover:bg-accent ${thread.id === selectedThreadId ? "bg-accent" : "bg-transparent"}`}
            >
              <span className="shrink-0 mt-0.5 text-muted-foreground opacity-50">
                <IconChat size={14} />
              </span>
              <div className="flex-1 min-w-0">
                {editingThreadId === thread.id ? (
                  <input
                    autoFocus
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onBlur={async () => {
                      const trimmed = editingTitle.trim();
                      if (trimmed && trimmed !== thread.title) {
                        await updateThreadTitle({ threadId: thread.id, title: trimmed });
                        refreshThreads();
                      }
                      setEditingThreadId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setEditingThreadId(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="text-[13px] w-full bg-transparent border border-border rounded px-1 py-px text-foreground outline-none"
                  />
                ) : (
                  <div
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setEditingThreadId(thread.id);
                      setEditingTitle(thread.title || "New Chat");
                    }}
                    className="text-[13px] overflow-hidden text-ellipsis whitespace-nowrap text-foreground"
                  >
                    {thread.title || "New Chat"}
                  </div>
                )}
                <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1">
                  <span>{formatTime(thread.updatedAt)}</span>
                  {thread.status === "running" && (
                    <span
                      className="chat-tool-pulse inline-block w-1.5 h-1.5 rounded-full bg-[#22c55e]"
                    />
                  )}
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirmDeleteId === thread.id) {
                    handleDeleteThread(thread.id);
                    setConfirmDeleteId(null);
                  } else {
                    setConfirmDeleteId(thread.id);
                  }
                }}
                className={`bg-transparent border-none cursor-pointer px-1 py-0.5 whitespace-nowrap opacity-50 mt-px transition-colors duration-150 ${confirmDeleteId === thread.id ? "text-[#ef4444] text-[10px] font-semibold" : "text-muted-foreground text-sm font-normal"}`}
                title={confirmDeleteId === thread.id ? "Click again to confirm" : "Delete thread"}
              >
                {confirmDeleteId === thread.id ? "Delete?" : "\u00d7"}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* ── Main area ── */}
      <div className="flex-1 flex flex-col min-w-0">

        {/* ── Messages area ── */}
        <div className="chat-scroll flex-1 overflow-auto px-8 relative">
          {/* Sidebar toggle */}
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="sticky top-2 left-0 z-10 bg-transparent border-none cursor-pointer text-muted-foreground p-1 flex items-center opacity-40 -mb-7"
            title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
          >
            <IconSidebar size={16} />
          </button>
          {/* Welcome screen */}
          {!selectedThreadId && (
            <div className="flex flex-col items-center justify-center h-full gap-5 px-6">
              <div className="text-muted-foreground opacity-30">
                <IconChat size={32} />
              </div>
              <h2 className="text-lg font-semibold text-foreground m-0">
                What can I help with?
              </h2>

              {/* Input on welcome screen */}
              <div className="w-full max-w-[520px]">
                <ChatInput
                  {...inputProps}
                  placeholder="Ask Paperclip anything..."
                />
              </div>

              {/* Quick action chips */}
              <div className="flex flex-wrap justify-center gap-2 max-w-[520px]">
                {QUICK_ACTIONS.map((trigger) => (
                  <button
                    key={trigger.label}
                    onClick={() => handleQuickAction(trigger.prompt)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border py-2 px-3.5 text-xs text-muted-foreground bg-transparent cursor-pointer transition-all duration-150 hover:text-foreground hover:border-foreground/20 hover:bg-accent"
                  >
                    {trigger.label}
                  </button>
                ))}
              </div>

              {/* Recent threads */}
              {threads && threads.length > 0 && (
                <div className="w-full max-w-[520px] mt-2">
                  <div className="flex items-center justify-between mb-2 px-1">
                    <span className="text-[11px] text-muted-foreground opacity-50 font-medium">
                      Recent
                    </span>
                    {threads.length > 3 && (
                      <button
                        onClick={() => setSidebarCollapsed(false)}
                        className="text-[11px] text-muted-foreground opacity-50 bg-transparent border-none cursor-pointer p-0"
                      >
                        View all
                      </button>
                    )}
                  </div>
                  <div className="flex flex-col gap-1">
                    {threads.slice(0, 3).map((thread) => (
                      <button
                        key={thread.id}
                        onClick={() => setSelectedThreadId(thread.id)}
                        className="flex items-center gap-3 rounded-lg border border-border py-2.5 px-3 text-left bg-transparent cursor-pointer transition-all duration-150 w-full hover:bg-accent hover:border-foreground/10"
                      >
                        <span className="shrink-0 text-muted-foreground opacity-30">
                          <IconChat size={14} />
                        </span>
                        <span className="text-[13px] text-foreground opacity-70 overflow-hidden text-ellipsis whitespace-nowrap flex-1">
                          {thread.title || "New Chat"}
                        </span>
                        <span className="text-[10px] text-muted-foreground opacity-30 shrink-0">
                          {formatTime(thread.updatedAt)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Thread messages */}
          {selectedThreadId && messages?.map((msg) => (
            <MessageRow key={msg.id} msg={msg} />
          ))}

          {/* Live streaming message */}
          {selectedThreadId && isStreaming && (
            <StreamingMessage
              segments={[]}
              streamingText={streamingText}
              streamingThinking={streamingThinking}
              streamingError={streamingError}
              isActive={true}
            />
          )}

          {/* Empty thread placeholder */}
          {selectedThreadId && !isStreaming && (!messages || messages.length === 0) && (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm opacity-50">
              Send a message to get started
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* ── Bottom input (only when in a thread) ── */}
        {selectedThreadId && (
          <div className="border-t border-border py-3 px-8 bg-card">
            <ChatInput
              {...inputProps}
              placeholder="Ask Paperclip anything..."
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChatSidebarPanel — compact sidebar entry point
// ---------------------------------------------------------------------------

export function ChatSidebarPanel() {
  return null;
}

// ---------------------------------------------------------------------------
// ChatSidebarLink — sidebar nav item rendered by PluginSlotOutlet
// ---------------------------------------------------------------------------

type PluginSidebarProps = {
  context: { companyPrefix?: string | null };
};

export function ChatSidebarLink({ context }: PluginSidebarProps) {
  const prefix = context.companyPrefix ?? "";
  const href = "/" + prefix + "/chat";
  const isActive = typeof window !== "undefined" && window.location.pathname === href;
  return (
    <a
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors",
        isActive
          ? "bg-accent text-foreground"
          : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
      ].join(" ")}
    >
      <IconChat size={16} />
      <span className="flex-1 truncate">Chat</span>
    </a>
  );
}
