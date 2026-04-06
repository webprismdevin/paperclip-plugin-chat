import type { ChatMessage } from "../types.js";

export function deriveAutoThreadTitle(message: string): string {
  const shortTitle =
    message.length > 60 ? message.slice(0, 60).replace(/\s+\S*$/, "") + "..." : message;

  return shortTitle.split("\n")[0] ?? shortTitle;
}

export function shouldReplaceAutoTitle(params: {
  currentTitle: string;
  firstUserMessageContent: string | null;
}): boolean {
  const { currentTitle, firstUserMessageContent } = params;

  if (!firstUserMessageContent) {
    return false;
  }

  return currentTitle === deriveAutoThreadTitle(firstUserMessageContent);
}

export function rewindThreadFromUserEdit(params: {
  messages: ChatMessage[];
  messageId: string;
  nextContent: string;
  editedAt: string;
}): {
  messages: ChatMessage[];
  editedMessage: ChatMessage;
  deletedMessageIds: string[];
} {
  const { messages, messageId, nextContent, editedAt } = params;
  const targetIndex = messages.findIndex((message) => message.id === messageId);

  if (targetIndex === -1) {
    throw new Error(`Message not found: ${messageId}`);
  }

  const target = messages[targetIndex];

  if (!target || target.role !== "user") {
    throw new Error("Only user messages can be edited");
  }

  const editedMessage: ChatMessage = {
    ...target,
    content: nextContent,
    updatedAt: editedAt,
  };

  const keptMessages = messages.slice(0, targetIndex);
  const truncatedMessages = messages.slice(targetIndex + 1);

  return {
    messages: [...keptMessages, editedMessage],
    editedMessage,
    deletedMessageIds: truncatedMessages.map((message) => message.id),
  };
}
