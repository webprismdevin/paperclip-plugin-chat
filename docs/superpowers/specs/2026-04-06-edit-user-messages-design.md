# Edit Previous User Messages In Chat

## Summary

Add support for editing any previous `You` message in the Paperclip chat plugin. Editing a user message will not only change the displayed text. It will rewind the thread from that point onward:

- replace the selected user message content,
- remove every later message in the thread,
- reset the agent session for the thread,
- regenerate the assistant response from the edited message onward.

This feature is intentionally implemented as rewind-and-regenerate, not in-place historical editing, because the plugin persists visible messages but does not persist a fully replayable internal agent state.

## Goals

- Let users edit any previous `You` message in a thread.
- Keep the visible thread coherent after the edit.
- Reuse the existing send/streaming model instead of introducing a second regeneration pipeline.
- Make the edited state obvious in the UI.

## Non-Goals

- Perfectly reconstruct the original hidden runtime state of the agent.
- Preserve assistant messages or tool activity after the edited point.
- Allow editing assistant messages.
- Allow branching or comparing alternate histories.

## User Experience

### Entry Point

Each persisted message with `role === "user"` shows an `Edit` action.

- The action is only available when the thread is not currently `running`.
- Assistant and system messages do not show the action.

### Editing Flow

When the user clicks `Edit` on a previous `You` message:

1. That message switches into inline edit mode.
2. The original message body is replaced by a textarea containing the current content.
3. Two actions appear: `Save` and `Cancel`.
4. `Save` is disabled for empty or whitespace-only content.

When the user saves:

1. The edited message content replaces the original message.
2. Every message after that point is removed from the thread.
3. The thread session is reset.
4. The thread enters the normal `running` state.
5. The assistant regenerates from the edited message onward.

When the user cancels:

- The message returns to normal display unchanged.

### Edited Marker

Edited user messages show a small `edited` marker beside the timestamp. This avoids silently rewriting history in the UI.

## Behavioral Rules

### Thread Rewind

Given a thread:

- `user A`
- `assistant A`
- `user B`
- `assistant B`
- `user C`
- `assistant C`

If `user B` is edited:

- `user A` remains,
- `assistant A` remains,
- `user B` content is replaced,
- `assistant B`, `user C`, and `assistant C` are deleted,
- regeneration starts from edited `user B`.

### Session Reset

Any save operation resets the thread session by clearing the stored `sessionId`. This forces the next response to run in a fresh session and avoids mixing pre-edit hidden state with post-edit visible history.

### Title Handling

If the edited message is the first user message and the thread title still reflects the original auto-generated text, the title should be recalculated from the edited content using the same truncation logic already used for new threads.

If the user manually renamed the thread, editing messages should not overwrite that custom title.

The implementation should detect an auto-generated title by recomputing the current derived title from the first user message before the edit. Only if the stored title matches that derived value should it be replaced after the edit.

## UI Design

### Message Row

`MessageRow` will support two modes for user messages:

- display mode,
- edit mode.

Display mode shows:

- avatar,
- author label,
- timestamp,
- optional `edited` marker,
- message body,
- `Edit` action.

Edit mode shows:

- the same header row,
- textarea prefilled with the current message text,
- `Save` and `Cancel` actions.

### Interaction Constraints

- Only one message can be in edit mode at a time.
- Starting edit on one message closes edit mode on another.
- Editing is blocked while the thread is `running`.
- Saving an edit clears any transient local streaming buffers before regeneration starts.

## Data Model

### ChatMessage

Extend `ChatMessage` with:

- optional `updatedAt: string`

This is used to determine whether a message was edited and to show the `edited` marker.

No additional historical revision tracking is stored in this feature.

## Worker Design

Add a new action:

- `editMessage`

Inputs:

- `threadId`
- `messageId`
- `message`
- `companyId`

### editMessage Flow

1. Validate required parameters.
2. Load the thread.
3. Reject if the thread does not exist.
4. Reject if the thread is currently `running`.
5. Load thread messages.
6. Locate the target message by `messageId`.
7. Reject if not found.
8. Reject if the target message is not a user message.
9. Replace the target message content and set `updatedAt`.
10. Truncate all later messages.
11. Reset `thread.sessionId` to `null`.
12. Set `thread.status` to `running`.
13. Recalculate title when applicable.
14. Persist the truncated message list and updated thread.
15. Reuse the existing send/regeneration path so the edited message produces a new assistant reply.

### Reuse Strategy

The implementation should reuse the current `sendMessage` pipeline as much as possible instead of duplicating:

- agent selection,
- stream opening,
- parser wiring,
- assistant message persistence,
- error handling,
- final thread status transitions.

The cleanest shape is to extract the common regeneration logic into a helper that both `sendMessage` and `editMessage` can call.

That helper must support two modes:

- append-and-send for normal `sendMessage`,
- send-existing-tail-message for `editMessage`, so the edited user message is not duplicated in persistence before regeneration starts.

## Error Handling

### Validation Errors

Return clear action errors for:

- missing parameters,
- thread not found,
- message not found,
- non-user message edit attempts,
- empty edited text,
- edits attempted while thread is running.

### Regeneration Failure

If regeneration fails after the edit is saved:

- the edited message remains saved,
- later messages remain deleted,
- the thread returns to `idle`,
- the existing UI error surface shows the failure.

This behavior is acceptable because the visible conversation has intentionally been rewound.

## Testing

### Worker Tests

Add coverage for:

- editing the last user message,
- editing a middle user message and truncating later content,
- rejecting edits to assistant messages,
- rejecting edits while thread is running,
- resetting `sessionId`,
- marking the edited message with `updatedAt`,
- recalculating the thread title only when it is still auto-generated.

### UI Tests

Add coverage for:

- `Edit` visible only on user messages,
- inline edit mode rendering,
- save disabled for blank edits,
- save triggers the new action,
- `edited` marker rendering.

### Manual Verification

Verify:

1. Edit the first user message in a thread and confirm the title updates when auto-generated.
2. Edit a middle user message and confirm later messages disappear immediately.
3. Confirm regeneration starts after save.
4. Leave and re-enter Chat while regeneration is running and confirm the existing recovery flow still resolves correctly.

## Risks

- If helper extraction from `sendMessage` is done carelessly, it can regress normal message sending.
- Title recalculation can overwrite custom titles unless explicitly guarded.
- UI state for message editing can conflict with thread-level streaming state unless edit mode is blocked during runs.

## Recommendation

Implement this as a rewind-and-regenerate feature for any previous user message, backed by a new `editMessage` worker action and a small `updatedAt` marker on user messages. This gives users the expected `edit and retry` behavior without pretending the plugin can replay the hidden internal state of the agent exactly.
