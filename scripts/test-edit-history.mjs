import assert from "node:assert/strict";
import {
  deriveAutoThreadTitle,
  shouldReplaceAutoTitle,
  rewindThreadFromUserEdit,
} from "../dist/chat/edit-history.js";

const originalMessages = [
  {
    id: "u1",
    threadId: "thread-1",
    role: "user",
    content: "Original first question",
    metadata: null,
    createdAt: "2026-04-06T00:00:00.000Z",
  },
  {
    id: "a1",
    threadId: "thread-1",
    role: "assistant",
    content: "First answer",
    metadata: { segments: [{ kind: "text", content: "First answer" }] },
    createdAt: "2026-04-06T00:00:01.000Z",
  },
  {
    id: "u2",
    threadId: "thread-1",
    role: "user",
    content: "Original second question",
    metadata: null,
    createdAt: "2026-04-06T00:00:02.000Z",
  },
  {
    id: "a2",
    threadId: "thread-1",
    role: "assistant",
    content: "Second answer",
    metadata: { segments: [{ kind: "text", content: "Second answer" }] },
    createdAt: "2026-04-06T00:00:03.000Z",
  },
];

assert.equal(
  deriveAutoThreadTitle("A very long first question that should be truncated before sixty characters in the title"),
  "A very long first question that should be truncated...",
);

assert.equal(
  shouldReplaceAutoTitle({
    currentTitle: deriveAutoThreadTitle(originalMessages[0].content),
    firstUserMessageContent: originalMessages[0].content,
  }),
  true,
);

assert.equal(
  shouldReplaceAutoTitle({
    currentTitle: "Custom title",
    firstUserMessageContent: originalMessages[0].content,
  }),
  false,
);

const rewound = rewindThreadFromUserEdit({
  messages: originalMessages,
  messageId: "u2",
  nextContent: "Edited second question",
  editedAt: "2026-04-06T00:05:00.000Z",
});

assert.equal(rewound.messages.length, 3);
assert.deepEqual(
  rewound.messages.map((message) => message.id),
  ["u1", "a1", "u2"],
);
assert.equal(rewound.messages[2].id, "u2");
assert.equal(rewound.messages[2].content, "Edited second question");
assert.equal(rewound.messages[2].updatedAt, "2026-04-06T00:05:00.000Z");
assert.deepEqual(rewound.deletedMessageIds, ["a2"]);

assert.throws(() => {
  rewindThreadFromUserEdit({
    messages: originalMessages,
    messageId: "missing",
    nextContent: "Nope",
    editedAt: "2026-04-06T00:05:00.000Z",
  });
}, /Message not found: missing/);

assert.throws(() => {
  rewindThreadFromUserEdit({
    messages: originalMessages,
    messageId: "a1",
    nextContent: "Nope",
    editedAt: "2026-04-06T00:05:00.000Z",
  });
}, /Only user messages can be edited/);

console.log("edit history rules ok");
