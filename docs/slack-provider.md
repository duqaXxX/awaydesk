# The Slack provider

How the Slack provider (`src/chat/slack/`) draws the chat seam: how it writes a reply to Slack,
serves `!open`, publishes the session index on the app's Home tab, and handles what Slack sends.
The core, the two seams, the sessions and the state file are in
[architecture.md](architecture.md), which also defines the terms used here. A note of the form
`measured: "..."` names a row of
[Measured platform behaviour](architecture.md#measured-platform-behaviour).

## Writing to Slack

The Slack provider's `ReplySink` (in `sinks`, the implementation of the chat seam's reply) writes
each reply as a native Slack stream inside the session's own thread, below the message that asked for it (`chat.startStream` with chunks, addressed to the owner's user
and team). The stream starts with Claude's first content, its first text or the card of the first
tool when a turn opens with one, and never with a placeholder. It grows with `chat.appendStream` at
most once every `sinks.DEBOUNCE_SECONDS` per reply, and each append draws from one shared
`UpdateLimiter` (in `limiter`, an option of the Slack provider, `SlackChatOptions`), as does every
`chat.update`: a token bucket that paces writes evenly at 40 per 60 seconds plus a burst of 5, worst
case 45 in one window, under the documented floor of `chat.update` (Tier 3, 50 or more a minute, per
app), so several busy threads together stay under the app's own budget instead of racing through it
and then freezing until it resets. A write that waited `limiter.UPDATE_WAIT_LOGGED_SECONDS` or more
for its turn is logged with the time it waited, which is what tells whether the budget ever held
back what the owner sees.

### Retries and writes in flight

The retries of a Slack call are the daemon's own policy, in `clients`. Both clients are built with
the library's retries switched off (`clients.SENT_ONCE`), and the policy is applied around the
client's `apiCall`:

| Failure | What is sent again |
|---|---|
| Slack rate limited the call (HTTP 429) | every method, after the `Retry-After` Slack gave, up to `clients.RATE_LIMIT_RETRIES` (3) times: a rate limited call never ran. A 429 with no valid `Retry-After` is not sent again. Once the daemon stops, a rate limited call is not sent again either, and the pause of one that waits ends (`ClientOptions.stopped`): the call is thrown as rate limited. Each rate limit is logged with its method, the `Retry-After` Slack gave and which send of the call it answered, never the call's arguments |
| the connection failed before an answer (a reset, a refused or unreachable host), or Slack answered with HTTP 500 or 503 (`clients.SERVER_ERROR_STATUSES`) | once, after a backoff pause, while no retry of the call was made yet. `clients.sharedClient` does so for every method. `clients.repliesClient`, the one replies are written with, does so for every method but the four of `clients.CREATING_METHODS`, `chat.postMessage` and the three stream calls: they are not idempotent, and a reset can come after Slack applied the call; whether a 500 or a 503 can was not measured, and they are left out for those too |
| anything else | never: an error Slack answered with, any other HTTP status, and the client's own timeout (`clients.REQUEST_TIMEOUT_MS`, 30 seconds), since a timed out call may have run |

For the four creating calls the sink reads the thread back and adopts what landed
(`ReplySink.adopt`). The library's `files.uploadV2` is passed through untouched: the two Slack
methods it calls come back through `apiCall` and are retried there, one by one.

A write to Slack that has begun always runs to its end. A pass of the sink (`ReplySink.flush`) takes
the reply's lock, brings every message to the model and ends the reply if it has ended; once asked
for it is never cancelled, and the next pass queues behind it. The Slack client cannot abort a call
in flight, and a call given up after Slack took it would lose a message's ts or post an ending
twice. What can be cancelled is a wait outside a pass: the debounce before a write, the pause before
the end's one retry, the stream's 280 seconds, and a caller's own wait for a pass. `finish`,
`closeOut`, `waitLanded` and `settle` take an `AbortSignal`: aborting it rejects that call and
leaves the pass running. `ReplySink.settle` then waits for what is in flight.

### Order, runs of calls and cards

Within a reply, writes happen in the order things happen. Claude's text goes as `markdown_text`
chunks. Tools go as `task_update` chunks, each a card Slack updates in place by its id.

A run of calls, the calls between two pieces of text, shares two cards (`fold.Fold`, fed by
`ReplySink.task`). One call of the run is shown whole, titled with the tool's name and its first
argument: the last call started that still runs, else the last one shown, which joins the counts
when another call takes its place. Until there is a call to count, the first card shows that call,
and a run of one call stays one card. From then on the first card holds the counts of what ended, in
the terminal's words where the terminal has words (`previews.folded`:
`Ran 2 shell commands · Read 1 file`), the failed calls after `✗`, and the second card shows the
call. Calls that run at the same time show one at a time. A failed call says why in its title
(`Bash: pytest -q · Exit code 1`). Neither card carries `details` or `output`: Slack appends both to
what a card already holds (measured: "Card text is appended"), so a card that is reused keeps its
text in its title.

A call with a view of its own has a card of its own, keyed by its call id, and ends the run: a
subagent, whose title counts its calls and whose `details` say what it is doing now, a background
task, which keeps its card `in_progress` for as long as it runs, and a stopped call. A call that
turns into one of these while a card of a run shows it keeps that card. An `Edit` or a `Write` that
ended well also ends the run, and has no card: its preview is all that shows it.

Once the reply's body has ended, each run reads as one line of counts in a `context` block
(`✓ Ran 2 shell commands · Read 1 file · ✗ Ran 1 shell command`), as the terminal folds a run that
ended (`TaskUpdate.folded`, `ReplySink.cardBlocks`). A stream cannot replace what it showed, so the
line is written by the `chat.update` that follows the stream's stop (`ReplySink.end`), which never
notifies. The reply has ended with the stop: an update that fails is tried once more with the next
write, and the cards stay if that fails too.

The renderer keeps an `Edit` or a `Write` (`previews.PREVIEWED`) from the sink until its result
arrives, since a stream cannot take back the card a running call would get. While the call runs the
reply shows nothing for it; a call that waits for approval has the approval's message. One that
ended well is a `blocks` chunk with no card (`previews.preview`): a collapsible, full-width
`container` block (`blocks.previewContainers`), closed until the owner opens it, whose title is the
call's line (`Update(notes.txt)`), in code style through `rich_text_title` with the plain `title` as
the fallback, and whose subtitle is the sentence (`Added 1 line, removed 1 line`). Inside a diff's
container is the whole numbered diff in a rich text preformatted element with the language `diff`,
which Slack desktop colours; each changed line also carries a red or green square after its sign,
since Slack mobile colours nothing. A new file's container holds its first 10 lines and
`… +N lines`. A body longer than `blocks.MESSAGE_LIMIT` continues in a second container with the
same title; both sit in one message when it is written by update, and in the next message when it is
streamed or posted. One that failed joins its run as a call that ended, with the reason in its
title; one that was stopped has a card of its own; one whose preview has no lines (an empty new
file) has a card that says the sentence. A card the sink already drew for the call stays
(`Tool.cardless`), and the diff under it is then titled with the sentence alone. An answered
`AskUserQuestion` shows its answers the same way, as a `context` block of words (`Preview.plain`).
Its lines come from the questions and answers the daemon sent back, so they depend on no
undocumented field. The preview is built from the event's `FileChange`, which the back end reads
from the `tool_use_result` of the `user` record (`translate.fileChange`). The SDK types that field
as `unknown` and does not document it; any shape other than the one measured gives no `FileChange`
and the call shows its generic card, and the release probe's claim P13 checks the shape on each new
SDK.

### The stream and the 280 seconds

The stream stays open until the reply ends, or the reply rests, or until `sinks.STREAM_SECONDS`
(280 seconds) after it started, whichever comes first. Slack closes a stream 5 minutes after
`chat.startStream` (measured: "Stream lifetime"), and the daemon stops it a little earlier itself.

- **The reply ends first.** `ReplySink.closeOut` stops the stream with `chat.stopStream`, passing
  the footer `ReplySink.finish` was given, a divider and a context block, as `blocks` at the
  message's bottom (Slack renders them below the stream, buttons included). The stop is the one
  notification.
- **The reply rests first.** A turn that ends with a background task still running or still to be
  reported leaves its reply waiting. `ThreadSession.closeReply` then calls `Reply.rest`: the next
  pass stops the stream with the same footer blocks at its bottom (the stop is the one
  notification, and creates no message, so it takes no lock of the thread's places), and the
  message goes on by `chat.update`, silently, as after the 280 seconds. A running card is rewritten
  in the same pass. The reply counts as at rest from then on (`finish` ran, `rest` was
  called and its last message is no stream; `rest` itself triggers the placement), so the thread's
  footer shows under it before it ends. The report grows the message by
  edit, `finish` runs again with the footer of the report turn, and the reply rests again or ends
  as below: the ending is posted with the footer and cut out of the message it grew in. A stop that
  fails leaves the stream open, text given meanwhile goes on to it, and the next pass tries again, which a try after `FINAL_RETRY_SECONDS` starts when nothing else changes.
  A reply that only finished, with no `rest` and no landed end, is not at rest: it shows no footer
  and takes none from the reply above, since its end follows at once and may fail.
- **280 seconds pass first.** `ReplySink.expire` stops the stream (Slack pushes on the stop, the
  first notification) and the same message keeps growing with `chat.update`, which never notifies
  (measured: "Update after stop is silent"). Each update writes the whole message from the
  renderer's model as `markdown` blocks and `task_card` blocks (a run of calls keeps its two cards
  until the body ends), with a short `text`, since a `chat.update` whose `text` is long fails
  `msg_too_long`. The end posts the reply's ending as a new message, the second notification
  (`ReplySink.end`): the text Claude wrote after its last call, whole, with whatever follows it, and
  the footer under it. Its `text`, the banner, is the first paragraph of that text as plain text
  (`markdown.bannerText`), so the notification says how the work ended, the stream's own stop having
  said how it began. The ending is a whole part of the renderer's model, never a cut inside one
  (`ReplySink.endingCursor`), so no list or heading is split. It is posted first, then a silent
  update takes it out of the message it grew in: a failed post leaves the reply as it was, a failed
  update leaves the text twice, and in both cases the end has not landed and the one retry follows.
  When the message holds no such text, or nothing of the answer would stay before it (an answer that
  is text alone), nothing is moved and the new message is the footer alone
  (`ReplySink.writeClosing`), its banner the start of Claude's answer, never a line of the daemon's.
  A turn cut short gets no footer (the Claude Code process was lost, another error ended it, or the
  daemon restarted or closed the session), and `ThreadSession.abandon` writes a line on how the
  reply ended (`Claude Code reported an error: …`, `This reply ended before an answer: …`). When
  Claude wrote text after its last call, that line follows the text into the new message, whose
  banner is still the start of the text. When there is no such text to move, the line itself is the
  ending that moves, with whatever follows it, and is the banner. A process lost while no turn is
  active is told by what the session still owed: a reply that waited for a background task of its
  own gets the same line, which counts as text since it rested, so its ending is posted as above,
  and the root shows ❌; a session with nothing running
  and nothing waiting gets no line and keeps the reaction it had, since its last reply ended well
  and the next message connects a new process. The sink keeps it as a part of its own
  (`ReplySink.text` with `ending`, fed by `TurnRenderer.feedEnding`), so a notice written just
  before it stays in the reply, and a card that closes after it moves under it. No other line of the
  daemon's moves. A footer goes under the line: a report turn cut short renders into a reply that
  already has the footer of its first turn. When a full message pushed the line, or the note under it, into a
  continuation, that message rang when it was posted and is the ending as it stands
  (`ReplySink.opensOnEnding`): no closing message follows. A line that does not fit the room left in
  a message is cut there, as any text is, and the continuation then rings with the rest of it. The
  new message shows empty in one known case: a turn that ended well with an answer of text alone,
  whose footer could not be built.
- **Something sits below.** A reply ends where it is when another reply's message sits below its
  last message (`Reply.overtaken`), or when it rested, a message of the owner's sits below it and
  no text of Claude's was written to it since it rested (`ReplySink.leftBehind`): the footer goes
  under that message by a silent edit (`ReplySink.end`), or on the stream's stop while it is still
  a stream, and nothing is posted, since a new message would land under the other reply, or
  repeat the old text as the newest in the thread. A task's end line or a card update is not such
  text; a report's text is. A reply with another reply below it opens no continuation either:
  what does not fit the message is cut, as a card's text is, and a warning is logged once. A reply
  that is still writing its turn when the owner writes posts its ending, unless it then rests and
  gets no text before it ends; one that rested and then got a report posts its ending as above.
  `SlackChat` keeps one `ThreadPlaces` (`reply/places.ts`) per channel and thread, shared by every
  `SlackThread` of it and in memory only. A `SlackThread` takes it at its first reply and gives it
  back at its close; it lives while one is open, and after the last give-back while a reply is
  registered with it, so a reply let go of by an owner message is still found by the next one. A
  `ReplySink` registers with it when it is built and
  tells it where its last message moved; the listener tells it the `ts` of every message the owner
  wrote in the thread (`SlackChat.ownerPosted`), also one the prompt filter drops. A reply is let
  go of once its end has landed and an owner message sits below it with no reply of its stretch
  still to end, above it or below (that reply may take the stretch's footer, so a stretch is let
  go of as a whole), or the `SlackThread` that opened it closed, its end landed or not; the highest position of a reply let go of stays in the places, so the answers
  do not change when it goes. A `SlackThread` lets go only of the replies it opened. The places
  hold a lock for the creation of a message of any reply of the thread (a stream's start, a
  continuation, an ending, a closing message) and for the end's decision to create one, so that
  two replies cannot each decide on the other's absence. A restart forgets the places: the
  messages written before it are unknown and a footer they show stays where it is. A continuation
  planned before the reply was overtaken and not yet posted is dropped.
- **One footer between two owner messages.** The footer is placed by position
  (`ThreadPlaces.place`, from `tails` of the core): in each stretch of a thread between two
  messages of the owner, the lowest reply that is at rest or whose end has landed shows the footer, and every reply
  above it in the stretch shows none. The footer is the latest one a turn of the stretch left, so
  a lower reply whose turn had none shows the upper one's line. A reply writes its end with the
  footer it would be handed (`ThreadPlaces.tailIf`); once the reply rests or its end has landed the places hand it
  the footer (`ReplySink.assign`), and a change is written by a silent edit, or by the stop of a
  stream that is still open. A reply that gives its footer up while its last message is a closing
  message that held the footer alone has that message deleted with `chat.delete`; the reply stays
  ended and no second closing message is posted. A footer assigned to it later is drawn under its
  last body message. A delete that Slack refuses is logged, leaves the footer where it is and is
  tried once more after `sinks.FINAL_RETRY_SECONDS`; `message_not_found` counts as deleted. A
  write after the end that fails is tried once more the same way.

### Message limits and continuation

Slack holds a message to 12,000 characters and 50 blocks or task cards (measured: "Message limits");
the daemon stops at `blocks.MESSAGE_LIMIT` (11,000) and `blocks.BLOCKS_LIMIT` (45), which leave room
for a preview that arrives after its card and for the footer. Slack translates Claude's text into a
`header` per heading, a `table` per table, a `divider` per rule and `rich_text` for each run between
them, and holds a post and an update to 50 of those; a stream is not held to it, the update after
its stop is (measured: "Block cap after a stream stops"). `markdown.markdownStarts` counts a text
that way for a stream's plan, a post and an update alike, and `markdown.markdownCut` cuts it at a
block's start, before a heading that would end the message. While the reply is being written, a
write of its last message that Slack still refuses with `no more than 50 items allowed` halves the
message's room and is tried again (`ReplySink.tighten`), so the rest goes on in a new message; the
writes of the reply's end are not split. A reply past `blocks.MESSAGE_LIMIT` or
`blocks.BLOCKS_LIMIT` continues in a new message, a new stream while the first one still streams,
else a post. Every message a reply adds notifies once. A stream and a post count the text of a
collapsed container toward those 12,000 characters; `chat.update` does not (measured: "Container
text on update"). A message written by update therefore counts a container as one block and no
characters (`ReplySink.weight`), so a stopped message holds several large diffs where a stream would
have continued. A continuation is posted with the characters a post takes, then brought to what an
update takes by a `chat.update` of the same message (`ReplySink.postStep`). An update refused for
content that held a container is tried once more with the containers counted, as a post counts them
(`containersCounted`, kept for the message): what fits is written, and the rest goes on in a new
message, or is cut with the preview note when the span is fixed.

### When a reply ends

A reply whose turn has ended while a task of it still runs, or still waits on a turn Claude Code
starts to report it, rests; it ends once none does. A task the turn started keeps its card open
and updating in place, `ReplySink.finish` ends only the body, and `ThreadSession.stillOwed` decides
whether `Reply.rest` (still owed) or `ReplySink.closeOut` runs (the CLI can suppress the report's notification, so past
`constants.INJECTED_TURN_WAIT` `ThreadSession.expireUnreported` gives up on it). A report turn renders
into one reply only when several tasks end together; `ThreadSession.sweepClosedOut`, run after
every turn and after `ThreadSession.expireInjectedTurn`, ends every other reply left eligible. A
turn Claude Code starts on its own to report a background task renders into the reply of the
first of the ended tasks (then of the task the agent named) whose reply is still tracked, not
ended and the last thing in the thread (`ThreadSession.openingTarget`, `Reply.last`). When none
is, the report gets a reply of its own at the bottom (`ThreadSession.newReply`), and the
footer goes to the lowest reply of the stretch (see "One footer between two owner messages"). A reply that ends with a
message of the owner's or another reply below it (`Reply.last`) because no report came is logged at INFO. An owner's next prompt takes no
footer away.

A background subagent can hand its report back before, or without, a turn of that kind (measured
2026-10-10 on Claude Code 2.1.294 and 2.1.296 with the owner's setting sources loaded, recorded in
`test/fixtures/sdk/subagent-handback.jsonl`). Its last call is a tool named `SubagentHandback`;
the report reaches the main agent as a `user` record whose `origin` is a peer that names the task
(`SDKMessageOrigin`, `senderTaskId`), and the agent answers it in a turn of its own; the task's
notification then gets a turn that does nothing, an `init` and a `result` with `num_turns` 0 and
no text. The back end says the first as the event `report_started` with the task's id, and the
second as a `turn_ended` whose `steps` is 0. On `report_started` the session takes the turn that
follows as the report of that task whatever prompt waits (`ThreadSession.whoseTurn`) and renders
it in the reply that shows the task, also when the task ended inside the turn that started it and
is tracked nowhere (`ThreadSession.showing`); with no end line to open it, the report follows the
reply's text with no line of the daemon's between. A turn that did nothing and has nothing to say
(no end line, no held task event) opens no reply, and ends the wait for a report as a report turn
would (`ThreadSession.saidNothing`, `ThreadSession.nothingReported`). With an end line waiting, it
is the turn that writes that line, as before.

What happens to a prompt the owner sends while a turn runs, and how a turn takes one in, is under
[Sessions](architecture.md#sessions) ([A prompt taken into a running turn](architecture.md#a-prompt-taken-into-a-running-turn)).

### A reply cut short

`!stop`, a restart, an error that cuts a turn, an idle close and `SessionGone` end the reply through
the same path, at once: the stream stops with the footer and, for `!stop`, the stopped command's
card, and that stop is the notification (`ThreadSession.stopTaskReplies` for the tasks' replies). A
stream whose last append has an unknown outcome (a reset, a timeout) is told nothing more: it is
stopped and the message goes on by `chat.update` from the model. An append Slack refuses as too long
(`msg_too_long`) would be refused again, so `ReplySink.streamStep` stops the stream at once, without
the footer, and writes the message by `chat.update`; the end then posts the reply's ending, as for a
reply past `sinks.STREAM_SECONDS`. The text of a message's cards counts toward the cap of a streamed
message, by a formula Slack does not document (measured: "Card text cap"). Slack adds the `details`
and the `output` of every `task_update` to what the card holds, so a stream is sent only the lines a
card lacks (`blocks.cardAddition`), and `ReplySink.planCard` counts each card toward
`blocks.MESSAGE_LIMIT`: its title, the text it was sent, and a fixed cost per card, per text and per
line, set from that measurement. A new card that does not fit opens the next message; a card already
in a full message gains no more lines of `details`, and still gets its `output`. The count is an
estimate of what Slack stores, so a refusal remains possible; it is logged with the sizes the plan
knew and no content. When Slack refuses an update of any message for its content, the change is
dropped and the message shows less than the model: unless a later update of it passes, the reply's
end counts as not landed and the root shows ❌. The update that only folds the cards of a stream sent
all of its span is the exception, since nothing of the reply is missing. Each stretch of the thread between two owner
messages shows one footer, on its lowest reply at rest (see "One footer between two owner
messages"); the list of what still runs sits above that footer on the lowest reply at rest of
the whole thread (see "The list of what still runs"). A card left `in_progress` in a stopped message
is stored as an error until it is updated (measured: "Open card stored as error"), so every end
closes its cards first.

### The list of what still runs

While a subagent or a background command runs, one `task_card` lists it, above the footer's
divider, in the thread's last reply at rest: the lowest reply of the whole thread (not of a
stretch) whose turn has ended and whose last message is no stream (`tails` of the core, applied
by `ThreadPlaces.place`). A newer reply that is still a stream does not take it; one that rests
does, and the older one is edited without it. `ThreadChat.showRunning` hands the list over and
the reply that holds it writes it with its next pass, on a reply at rest or one whose end has
landed. The card is `{ type: "task_card", block_id: "running-list", task_id: "running-list",
status: "in_progress" }` with the title the core made (`2 agents · 1 shell still running`, cut at
`blocks.CARD_TITLE_LIMIT`) and `details` of up to `blocks.RUNNING_LIST_LINES` lines, one per task,
then `+N more`. The `block_id` is the same for the card's whole life, and no tool call's id has
that form. Taking the list off a reply is an edit too, and no write of it notifies.

A stream's stop carries the footer alone; the edit that follows adds the card, since no stop with
a `task_card` in its `blocks` was measured. A message that shows the list stays among the open
replies (`ReplySink.keepsOpen`), and `repair.endReply` removes the block whose `block_id` or
`task_id` is `running-list`, where it closes a left-over card as an error; on a message that only
the list kept open it writes no note. `ThreadPlaces` does not let go of the
reply that holds the list while it does, so that the list can always be taken off it; the close
of the thread settles every reply that ever held it, let go of or not. A reply takes the list only
from what the places assigned it once it rests, so the ending of a reply whose end is still on its
way carries the footer alone and never a second card. A write of the card that failed, or whose
answer was lost, is written again: the message's shown blocks are forgotten, and a reply at rest
tries once more after `FINAL_RETRY_SECONDS`. When a continuation is written, the message before it
is rewritten in the same pass, so that neither the footer nor the card is in two messages. After a
crash `repair.endReply` takes the card off a message that only the list kept open and writes no
note on it; one that also has a running call or an open stream keeps the note.

Measured on 2026-10-12, Slack on desktop: a `task_card` with a fixed `block_id` stays open
across `chat.update` when the text above it changes, when a line of its `details` is added or
removed, and when its title changes. A collapsible `container` does not stay open, and a
`task_card` inside a `container` is refused. A message with two blocks that share one `task_id` is
refused (`invalid_blocks`); `FakeSlack` does not check it, and `sinks.test.ts` does. Not measured:
whether the card's `details` count toward the 12,000 characters of a message written by
`chat.update`. The six lines of 80 characters and the title keep the card and the footer inside
the margin `blocks.MESSAGE_LIMIT` leaves.

### Pushes and threads

Slack's push behaviour is what makes this shape: a stream in a thread the owner started notifies
once, when it stops, with its first text as the banner, and never when it starts (measured: "Push on
stream stop"; Slack's reference says nothing on it). Every write while Claude works is silent. An
open stream cannot be deleted (measured: "Open stream cannot be deleted"), which is why a reply
never starts as a placeholder that a later write replaces.

`chat.startStream` works only inside a thread and answers `invalid_thread_ts` without `thread_ts`
(measured: "Stream needs a thread"), which the thread model satisfies. A write Slack refuses, or
cannot receive because the network is down, is sent again with the whole reply at the next write; it
never stops the Claude Code session. Every message the daemon posts turns link and media previews
off (`unfurl_links`, `unfurl_media`), so a link in Claude's text is never fetched by Slack on its
own. The end has no next write to fix it: when Slack refuses the content of a message of the end
that is not posted yet, a continuation or the reply's ending (`invalid_blocks`, `msg_too_long` and
the like, `errors.REFUSED_CONTENT`, not a rate limit), that message is posted once more as plain
text (`ReplySink.writePlain`), and the reply goes on to the next messages. A message that already
shows something is never replaced by a plainer one. An end that fails for any other reason (the
network, or a rate limit the client has already retried, or stopped retrying at the daemon's
stop) is tried once more after
`sinks.FINAL_RETRY_SECONDS`; until it lands, `ThreadSession` shows no ✅
(`ThreadSession.trackLanding`), shows ❌ if the retry fails too, and keeps the persisted status so
the next start's repair still finds the reply.

## Opening a file

`!open` shares a file of a session's folder into its thread, where Slack shows it in its own file
viewer. The word reaches the provider as `ChatProvider.openFile`, which `words.wordFlow` calls with
the session's folder and the words typed after `!open`; a chat that declares no `fileUpload`
answers `texts.OPEN_UNAVAILABLE` instead. The core decides what is offered, which files changed
since the thread started and which paths are safe to read (`src/core/files/`, described in
[Files offered by `!open`](architecture.md#files-offered-by-open)); the provider draws the picker and
the modal and uploads the file. `src/chat/slack/openfile/` holds `modal` and `read.uploadFile`, and
the class `Open` the handlers (`Open.openWord`, `Open.openFile`, `Open.openModal`,
`Open.updateModal`, `Open.onOpenChoose`, `Open.onOpenQuery`, `Open.onOpenSubmit`). The file goes up
with the Slack client's `files.uploadV2` (`files:write`, in `read.uploadFile`): the file itself, its
basename as the name and its path from the folder as the title, and nothing posted on success. The
size cap is Slack's limit for a snippet, `read.SNIPPET_LIMIT`, which `Open.openFile` hands to the
core's `readOpenable`; `Open.foundFiles` turns the thread's `thread_ts` into epoch seconds
(`open.startedAt`) for `changedIn`.

`!open` alone posts a message with one button (`modal.pickerBlocks`, action
`modal.OPEN_BUTTON_ACTION`); `!open <words>` with several matches posts the count and the same
button, carrying the words (at most `modal.QUERY_LIMIT` characters) as its value. The click is
handled by `Open.onOpenChoose`: it acknowledges, checks the owner, the workspace and the channel
(`Answers.admitted`), resolves the thread to the folder of its own entry in `state.json`
(`Open.threadFolder`), never the channel's, and opens the modal with `views.open`. The click's
`trigger_id` lives 3 seconds, which the channel check, the wait for the rows and `views.open` share:
the owner check and the thread's folder are local, so the listing starts before the channel check's
two calls to Slack, and the rows are waited for until `modal.OPEN_WAIT` seconds after the click came
in. When they are ready the modal opens with them, else it opens with a line that says the files are
being listed and an update fills it. The rows come from `Open.foundFiles`: the changed files, newest
first, while the search field is empty, and `Listings.search` over the folder's listing otherwise.

`modal.modalView` builds the view: an input block holding the search field (`dispatch_action` with
`trigger_actions_on: ["on_character_entered"]`, so each character is a `block_actions` event) and,
when there are rows, an input block holding a radio button group of at most `modal.ROW_LIMIT` (10)
options, whose label says what the rows are. An option's text is the file name as `plain_text` with
`emoji` false (shortened in its middle past 75 characters), so a name is never read as formatting;
its description is the folder (shortened from the left past 75, left out for a file at the root),
its value the path; a path over 150 characters gets no row. The search field keeps its `block_id`
and `action_id` in every view, which is what makes Slack keep the typed text through `views.update`
(the views.update reference, "Preserving input entry"). The same rule keeps the state of the rows'
radio group, a chosen row included, so its `block_id` is `open_choice_block:<mark>` with a mark of
the rows' values: other rows, another id, and the old choice is dropped. Only the view `views.open`
takes sets the field's initial value and focus. The thread travels in the view's `private_metadata`
(`modal.Target`) and comes back untrusted: each handler resolves it to the folder of that thread's
own session and refuses anything else.

Each typed character reaches `Open.onOpenQuery`, which checks the owner and the workspace alone (no
call to Slack for the channel: it runs once per character, and its rows reach only the owner's own
modal), reads the text from the action's `value` (else from `view.state.values`) and calls
`Open.updateModal`. Each character is handled on its own and their updates can finish in any order.
The daemon is the only writer of its modals, so an update carries no `hash` (optional in
`views.update`); `modal.ModalUpdates` orders them by the event's `action_ts` (the first fill of a
slow-opening modal has key 0): `ModalUpdates.claim` refuses an event not newer than one already
taken, one update of a view runs at a time (`ModalUpdates.lock`), and each checks that it is still
the newest when its turn comes and again before it writes (`ModalUpdates.current`), so an update
made stale while it waited is never sent. A rejection by Slack is logged by its error code and
dropped. At most `modal.MODALS_KEPT` views are tracked, and a view whose modal was submitted
(`ModalUpdates.forget`) is never tracked again.

The modal's **Open** button is a `view_submission` handled by `Open.onOpenSubmit`. The answer to
Slack is the first thing sent and makes no call to it: with no row chosen it is
`response_action: "errors"` on the radio block, or on the search field when the view has no radio
block (nothing to choose from); with a row, a plain acknowledgement, which closes the modal. A row
counts only when it is among the options of the submitted view's own radio block (`modal.chosenIn`),
so a choice Slack kept from other rows is none. The row's value is untrusted input, and
`read.readOpenable` resolves the links, refuses a path that leaves the folder or is no regular file,
then opens the resolved path once (`O_NOFOLLOW | O_NONBLOCK`), reads the size from that descriptor
and reads at most `read.SNIPPET_LIMIT` (1 MB) from it; an empty file is refused before any upload
(`texts.OPEN_EMPTY`). Every other failure of the open, the stat or the read is a `read.NotAFile` too,
and the owner reads `texts.OPEN_NOT_A_FILE` of it; when it has a cause with an error code
(`EACCES`, `ENOENT`), `Open.openFile` logs that code once with the channel and thread ids, never
the path. Slack gets those bytes, as a `Buffer` in the upload's `file` field: handing it
the path would let the library open the path again, following links and with no size limit.

## The session index

`Home` (in `home`) publishes the owner's Home tab with `views.publish`, which takes no scope and
needs no event from the owner. It always publishes to the configured owner's user id. The page is
the Slack provider's: `ChatProvider.index` is present, `main` asks
it to refresh when `state.json`'s sessions change, and `Home` reads the core through the port
(`CorePort.state`, `CorePort.agent`) alone.

`Home.publish` reads the bound channels (`StateStore.channels`) and asks Slack for each one's name
once per run (`conversations.info`); a channel Slack no longer has is left out with its threads. It
then builds one row per thread of those channels that holds a session id (`StateStore.threads`). The
title comes from Claude Code: the listing `Home` is given (its `sessionsOf` option, the back end's
`AgentBackend.listSessions`) lists each folder once, and a session it does not list yet shows
`Session` and the start of its id. The rest comes from Slack: `conversations.replies` with the
root's `ts` and `limit=1` returns the root alone, and `home.threadFacts` reads its `reply_count`,
its `latest_reply` and, among its `reactions`, the status one. A row is dated by the last reply, or
by the root while it has none, and the rows are ordered by that date. The status is a reaction
name: the one `reply.status.REACTIONS` draws for the word in `ThreadState.ended` when it is set,
for the word in `ThreadState.status` otherwise, and the reaction read from the root for a thread
that has neither (one that ended before the daemon kept it). `ended`
and `status` are both set only for an answer that never reached Slack, where the root shows ❌ and
`status` stays for crash repair. A root is read again only for a thread a state write touched since
the last read, which every turn does at its start and at its end (`StateStore.onSessionsChange`
names the threads it changed). Each row also needs a permalink (`chat.getPermalink`) for its
**Open** link: the one of the thread's last reply, whose `ts` is the root's `latest_reply`, or the
root's own while the thread has no reply. Slack opens a thread on the reply its permalink names
(measured: "Permalink opens on the reply"; the method's reference gives the link's form and says
nothing of the scroll). The last reply is the last message of the thread, the owner's included. The
link is kept per thread with that `ts` and asked again only when the `ts` changed, so a reply costs
one call. It carries a query (`?thread_ts=…&cid=…`), written into the page with `&` escaped as
mrkdwn takes it. `home.THREADS_AT_ONCE` threads are asked about at a time.

Only three answers are final, the ones in `errors.GONE`: `channel_not_found`, `message_not_found` and
`thread_not_found`. The channel or the thread is then left out, a thread until a state write touches
it again and a channel for the rest of the run. Any other failure (a rate limit, a server error, the
network, a root in a shape that cannot be read) is no answer: nothing is kept from it, what was read
before stands, and the page is tried again after `home.RETRY_SECONDS`. When Slack answered about no
channel at all, nothing is published, so the page that is there stays.

`home.homeView` lays the rows out. Under the controls, each channel is a group: a header with the
channel and a **New thread** link button (the `slack://channel` deep link), then two blocks per
session: a section with the title, and a context line with the status word, the number of replies,
the time of the last reply as Slack's own `{ago}` date token, which the client renders, so the age
stays right between two publishes, and an **Open** link to the thread. A context line holding
`home.SPACER` leaves a blank row between two sessions of a channel. With no filter chosen every
bound channel is a group, the ones with sessions first by their newest, each cut to
`home.PER_CHANNEL` cards with a **Show all** button; with a channel, a status or a search chosen
(`home.narrowed`), only the channels with a match, uncut. The period applies either way and leaves
that shape alone: a channel whose sessions are all older keeps its header and says
`texts.HOME_NO_MATCH`. A Home view holds 100 blocks and a session takes up to `home.CARD_BLOCKS` of
them: the page stops before the cap, and ends with `texts.HOME_MORE` when that leaves a session out.
The channel menu holds `All channels` and at most `home.CHANNEL_OPTIONS` (99) channels, so that it stays
within Slack's 100 options for a select menu.

The filters are a `home.HomeFilter` kept in memory: channel, status, period and a search on the
title. The period starts on the last 48 hours; the others start unset. The two blocks that hold the
controls take an id that follows the chosen filter: Slack keeps what a control shows for as long as
its block keeps its id, so a page built with another choice (after a restart, after **Show all**)
must change it for the controls to show that choice. Every use of a control reaches a listener of
`HomeControls` as a `block_actions` payload, checked on its own for the owner and the workspace (a
Home tab payload names no channel). A filter's payload carries the state of all four controls in
`view.state.values`, which `home.readFilter` reads by action id and turns into the filter; a status
or a date the page never offered keeps the current one. **Show all** carries its channel, and
`Home.publish` drops a chosen channel that is not bound or that Slack no longer has. `Home.choose`
then publishes at once. The **New thread** link button is followed by Slack itself and still sends
its click, which is acknowledged and not read; a session's **Open** is a link in text and sends
nothing.

`StateStore.onSessionsChange` calls `Home.request` after a write that changed what the page shows,
with the threads the write touched: a channel bound for the first time, a thread added or removed, a
session id, a root's reaction. A write that changes anything else (a reply's bookkeeping, a request,
bypass, effort, a rebind) does not. `Home.request` returns at once and publishes after
`home.DEBOUNCE_SECONDS`, so the burst of reaction changes one turn makes costs one publish; a change
that lands during a publish is followed by another. Publishes run one at a time, each built after
the one before it landed, so a filter just chosen is never replaced by an older page. On a stop,
`Home.close` runs after every session has closed and publishes what was still owed, giving up after
`home.CLOSE_SECONDS`.

### Edit mode and Delete

With the owner's user token configured (`SLACK_USER_TOKEN`, in `Config.chatVariables`), `module.deleter`
builds a `ThreadDeleter` (in `delete`) after checking with `auth.test` that the token is the owner's
own in the bot's workspace; `assemble` (`src/chat/slack/module.ts`) hands its `delete` and `clean`
to `Home`. Any other token stops the start with a `ConfigError`. The header line is then a section with an **Edit** button
(`home.EDIT_ACTION`), since a context block holds no button; without the token it stays the context
line and the page has no such control. `Home.edit` keeps the mode in memory and publishes. It keeps
the filters the page had on entering and puts them back on leaving, so one chosen inside edit mode
(**Show all** on the channel being cleaned) does not outlast it. In edit mode a channel's header has
no **New thread**, and the title row of each session whose status is not `working` or
`waiting for you` carries a `danger` button (`home.DELETE_ACTION`) with a `confirm` dialog that
names the thread, cut to the dialog's 300 characters. Slack sends the click only after the owner
confirmed. The listener checks the owner and the workspace, like every Home control, and
`Home.delete` acts only in edit mode. It publishes at once with the thread marked
(`HomeRow.deleting`): the row reads `texts.HOME_DELETING` in place of its status and has no button,
a section under the header counts the threads on their way (`texts.HOME_DELETING_ONE` or
`texts.HOME_DELETING_MANY`), and the channel's header counts its own
(`texts.HOME_CHANNEL_DELETING_ONE` or `texts.HOME_CHANNEL_DELETING_MANY`), since such a row can be
one a channel does not show. A second click on a thread already being deleted does nothing, and the
page is published again when the delete ended. What a delete or a clean-up that did not end has to
say is kept per thread or channel (`Home.notices`), so one's result does not erase another's: each
is a context line under the header that names its thread or channel, the latest `home.NOTICES_SHOWN`
of them, until the same one is tried again or edit mode is entered or left.

`ThreadDeleter.delete` acts only on a thread `state.json` holds. It asks `SessionManager.release`,
which answers false for a thread whose session is working or waits for the owner. Otherwise it holds
the thread, closes its live session (the test the idle close makes, as silent) and waits for the
teardown. While a thread is held `SessionManager.get` answers null for it, so a message sent in a
thread that is being deleted builds no session from the entry `state.json` still has and is answered
`texts.NOT_A_SESSION`; `!resume` refuses it too (`SessionManager.held`). `SessionManager.free` ends
the hold when the delete ended, either way.

The deleter then reads the thread page by page (`conversations.replies`, cursor pagination) and
deletes its replies with `chat.delete`: the bot's own with the bot token, every other with the
owner's. It reads the thread again after each pass and deletes the root only once a read shows no
reply left, so a message that arrived meanwhile goes too and no reply is left under a deleted root.
`message_not_found` counts as deleted. `cant_delete_message` (a message that is neither the owner's
nor the bot's, or a workspace that does not let the owner delete) is counted and the delete goes on:
with any such message the root stays, the thread stays in `state.json`, and the page says
`texts.HOME_DELETE_REFUSED` with the count. `chat.delete` is Tier 3 and both clients send a rate
limited call again, which is where a delete's time goes; threads are deleted one at a time, so two
deletes never spend each other's retries. Only a thread emptied to its root and past it is dropped
from `state.json` (`StateStore.removeThread`). Any other failure stops the delete and leaves the
thread where it is, with `texts.HOME_DELETE_FAILED` (or `texts.HOME_DELETE_BUSY` for a thread in
use); the same click later continues with what is left. The Claude Code session and its transcript
are not touched.

### Clean up

In edit mode a channel's header carries a button (`home.CLEAN_ACTION`) with a `confirm` dialog that
says what it deletes; `Home.clean` acts only in edit mode and on a bound channel, marks the channel
(its header reads `texts.HOME_CHANNEL_CLEANING`, a section under the page's header
`texts.HOME_CLEANING_ONE`), and publishes before and after. `ThreadDeleter.clean` reads the channel
page by page (`conversations.history`, cursor pagination) and takes the owner's and the bot's
messages that carry no `subtype`, are no reply of a thread, and that `state.json` does not hold as a
thread. One that carries `thread_ts` is taken only when `conversations.replies` on it, with
`limit=1`, returns its root with no `reply_count`: a thread taken for a leftover would lose its
root, so no answer, or one with no root, keeps the message. Each is deleted with its author's token,
as a thread's messages are. It shares the deleter's lock, so one clean-up or delete runs at a time.
A message Slack refuses to delete (`cant_delete_message`) is counted and the rest still goes
(`texts.HOME_CLEAN_REFUSED`); any other failure stops the clean-up with `texts.HOME_CLEAN_FAILED`,
and the same click later deletes what is left.

`Home.publish` never throws. `not_enabled` (the Home tab is off in the Slack app's settings) is
logged once and ends the publishing for that run; any other failure is logged by its error code and
tried again after `home.RETRY_SECONDS`.

## Slack handlers

A Slack listener does five things in this order: it acknowledges, checks who acted, reads the
payload, calls the core through `ChatInbound`, and draws what the core asks to be drawn.
`app.buildApp` builds the Bolt app and registers one listener per inbound path: `message` events,
the `file_change` event (below, "An audio clip"), the Approve, Deny, Answer and Skip buttons, the
question form's Next and Submit, the same-folder hold's two buttons, the setup's Model select and
Start (its Effort select and Bypass checkbox are only acknowledged, since Start reads every
control), the Bind and Resume buttons of the two lists, `!open`'s Choose a file button with its
modal's search field and Open, and the session index's controls (its filters, Show all, Edit, Delete
and Clean up, and its New thread link button, which is only acknowledged). The listeners are methods
of the classes of `src/chat/slack/app/` (`Requests`, `Open`, `ResumeBind`, `Clips`,
`HomeControls`), which share `Answers`: the checks, where an answer goes, and how a failure is told.
The app registers no slash command.

### The message listener

The `message` listener is the one that keeps an order. It checks the owner and the workspace
first, with nothing awaited (`Answers.fromOwner`), so that an event from anyone else takes no
place and reaches no Slack call. Then it takes its place among the messages of its thread
(`ThreadOrder.enter`, keyed by channel and thread, before its first await), waits for the places
taken before it, runs the channel check (`Answers.channelAllowed`) inside it and calls
`ChatInbound.message`, or `Clips.takeClip` for a clip, which ends the stretch: the place is left
on that call's return, before the core's work on the message ends, so a later message never waits
for a turn, a download or a setup the owner has not answered. A refused check leaves the place too.
Threads do not wait for each other, and a thread's entry is dropped when its last place is left.
A later message of a thread waits for the checks of the messages before it. A check is two calls,
each bounded by the client's 30 seconds (`clients.REQUEST_TIMEOUT_MS`), so about 60 seconds per
message ahead with no network, plus the pause of the one connection retry and any `Retry-After`
Slack sends; a message with none ahead waits for nothing. Other threads are not affected.
The buttons and forms keep no such order: each names the message it answers.

| The owner | The listener reads | The core decides |
|---|---|---|
| writes a message, a word included | an `InboundMessage` (`messages.inboundMessage`) | `ChatInbound.message`: `messages.messages`, which hands a word to `words.wordFlow` |
| answers a request: Approve, Deny, Skip, the question form, the hold's two buttons, the setup's Start | an `OwnerAnswer` | `ChatInbound.answer`: `answers.answersFlow` |
| uses a row of a list: Bind, Resume | a `ListPick` | `ChatInbound.picked`: `lists.lists`, over `bind.binding` and `resume.resuming` |

What stays in the provider is drawing and what only the provider has: the Model select's redraw of
the setup message, the question form's pages, `!open`, the Home tab's controls and the clips.
 Bolt acknowledges an event before its listener runs, and a
click's listener acknowledges first; each then checks the owner, the workspace and the channel
itself; a control of the session index, and a character typed in `!open`'s modal, come with no
channel and check the owner and the workspace. The question form's Next and Submit answer Slack
after checks that make no network call, since a missing answer can only be shown in that answer. A
failure after the checks reaches the owner as a line of its own (`Talk.replyOnFailure` for what a
flow does, `Answers.replyOnFailure` for what a listener does itself): a post in the thread for a
prompt, where a word's failure goes for a word. A listener that throws past that
is logged by the error's name. A link Slack made from a typed address (`<url|label>`, `<url>`)
reaches Claude Code as typed; a link the owner named reaches it as `label (url)`, so the address is
not lost; a mention stays in Slack's form (`<@U…>`), since naming the user would need a scope the
app does not have (`messages.slackUnescape`).

### Audio clips

An audio clip: a message whose one file Slack shows as audio (`media_display_type`) is held instead
of being sent (`voice.clip`, `Clips.takeClip`), since Claude Code takes no audio and the daemon
transcribes nothing. Slack writes a clip's transcript when asked for it and sends `file_change`
while it does (measured: "Clip transcript"). That event names a file and no user or channel, so its
listener (`Clips.onFileChange`) acts only on a file id the owner's own message left waiting, reads
the file with `files.info`, and checks the owner, the workspace and the channel again on what Slack
returns before anything is sent. When `transcription.status` is `complete`, the text (the preview,
or the file's `vtt` when Slack cut the preview, `voice.vttText`) goes through the same path as a
typed message, so the setup, the holds and the notices apply as they do to text, with one
difference: a transcript is never read as a word of the daemon or as a command, so what Slack heard
cannot change the permission mode. A clip that a typed message could not follow (a thread with no
session, an unbound channel, a file somebody else uploaded) is refused when it comes, before any
wait. A clip waits `voice.WAIT_SECONDS`, in memory only.

### Routing a message

A message is routed by the message flow, by whether it is a reply in an existing thread:
`messages.messages` reads `SessionManager.get` for a reply (null for a thread that holds no
session), and always null for a top-level one (`thread_ts == ts` in Slack's payload, `topLevel` in
the `InboundMessage`), even in a channel that is bound. `commands.parseBang` reads a message
starting with `!` (none for one carrying files or spoken, which is always a prompt: the message is
`literal`). The listener hands over the event's `text` and what `messages.unformatted` makes of it
(`InboundMessage.plain`), and `messages.messages` reads the `text` first, then the other. Slack puts the formatting marks in `text` (a backtick before the `!` of a message in inline
code) and sends the same message in the `rich_text` block of its composer, as `text` elements whose
`style` says how they look. `messages.unformatted` reads one thing in that block, the run the
message opens with, in a `rich_text_section` or a `rich_text_preformatted` part. When the run starts
with `!` and the text reads as marks, that run, then the same marks closing the run or the message,
it returns the text without those marks: the arguments stay as the owner sent them, with their own
formatting and links. Anything else returns nothing and the message stays a prompt: a quote, a list,
a message that opens with another element, and a message with no composer block, where nothing tells
a mark from a character the owner typed. The word ends at any whitespace, so a line break after it
separates the arguments as a space does. The words: `help`, `guide`, `bind`, `bypass`, `status`,
`stop` and `resume` and `open` are the daemon's own words (`commands.Word`), dispatched in
`words.wordFlow` by whether the lookup above found a session: `!resume` works only at the top
level, refused inside any thread (`texts.WORD_IN_THREAD`), and `!bind` is refused the same way in a
thread that holds a session, and with a folder in a thread that holds none; a bare `!bind` at the
top level or in a thread with no session lists the folders; `!bypass` only inside a thread,
refused at the top level (`texts.BYPASS_TOP_LEVEL`), and so is `!open` (`texts.OPEN_TOP_LEVEL`);
`!guide` answers the same either way; `!help`, `!status` and `!stop` answer both, but with different
content: `!help` lists only the daemon's words at the top level and a session's own commands too
inside its thread, except `clear`, which a thread refuses (`commands.refusedInThread`); `!status`
lists the channel's live sessions at the top level and one session's own values inside its thread;
`!stop` stops every session of the channel at the top level and one session inside its thread.
`!clear` is not a word of its own: it is an ordinary `Passthrough` that `messages.isClear` catches
only inside a thread, refused there (`texts.CLEAR_IN_THREAD`, one thread is one session), under each
of the agent's new-session names (`AgentWords.newSession`: for Claude Code `clear`, `reset` and
`new`, known before a rebuilt session has started), and any other alias the session's own command list gives `clear` (the
initialization result carries each command's aliases; measured: "Initialization result"). At the top
level it opens a new session like any other message, and reaches Claude Code as `/clear` if the
freshly started session offers that command. `!login` and `!logout` (`AgentWords.login` and `AgentWords.logout`) are `Passthrough`s the daemon
never sends (`commands.hostOnly`): they act on the host's own login, which the daemon and every
session run on, so `messages.messages` answers with `texts.LOGIN_ON_HOST` or
`texts.LOGOUT_ON_HOST` before any session is opened, in the channel or, inside a session's thread,
for the owner alone. Any other `!name args` is a `Passthrough` too: sent as `/name args` when the
session (freshly opened, at the top level) offers `name`, as the text itself otherwise. A top-level
message with no existing thread opens a new session (`SessionManager.open`); a message in a thread
that holds no session and is not a daemon word gets `texts.NOT_A_SESSION`, with nowhere to send it.

### Resuming a session

`!resume` stands in for Claude Code's interactive `/resume`, which an SDK session does not offer:
`resume` lists the directory's sessions from the back end's listing (`AgentBackend.listSessions`,
the SDK's `listSessions`) with the columns of the terminal's picker (name or title, time since the
last activity, git branch, size), the first 8 characters of the session id and a Resume button each,
or matches `!resume <id or name>`. The terminal's picker shows no id; the list shows its start
because `!resume` takes a full id or any start of one at least 8 characters long
(`resume.ID_PREFIX_MIN`; the list shows `resume.ID_SHOWN` of them). A session a thread already holds takes no row, and a line under the rows counts
them. The list is posted in the channel, and each button carries the session id and the ts of the
`!resume` message (`resume.parseResumeValue`). A Resume click or a typed `!resume <id or name>`
(`resume.resuming`) opens the chosen session in the thread of that message
(`SessionManager.resume`), with a fresh thread entry: bypass never chosen (the folder's own mode)
and no `/effort` level, whatever the session had before. It is refused, with no `await` between the
checks and the `resume` call they guard so nothing can change in between, when that thread already
holds a session (`texts.RESUME_HELD`: a resume is never a swap), when another thread already holds
the chosen session (`texts.RESUME_ELSEWHERE`, with a link to it: one session lives in one thread),
or when the channel was bound to another folder while the chosen session was read from the old one
(`texts.RESUME_GONE`); it never waits on, or touches, any other thread of the channel.

### Notices

The daemon's notices (the answer to `!bind`, `!bypass` and `!stop`, a word used in the wrong place,
a resume that did not happen or is refused, a refused attachment, a restart, and the ephemeral
errors) are a context block, small and grey as the footer, so they read apart from Claude's replies:
`ThreadChat.notice` for the session's own, `ThreadChat.tell` and `ChannelChat.notice` for the flows'
answers, `Answers.notice` and `Answers.tellOwner` for the Slack listeners'. A line for the owner
alone about a top-level message that has no reply yet goes to the channel
(`Answers.tellOwnerAbout`): Slack shows an ephemeral message in a thread only when the thread is
already active. That covers a refused attachment and a refused channel. The lines about an audio
clip are normal posts instead (`Answers.tellAbout`), in the clip's thread or in the channel for a
clip at the top level: Slack lets nobody delete or update an ephemeral message, and the line that
says a clip waits is deleted (`Answers.withdraw`) when its transcript arrives or the wait ends. A
clip whose file is somebody else's is still answered for the owner alone. The same holds
for the lines of the `!bind` and `!resume` lists; their rows keep a section, since a context block
holds no button. Their text is mrkdwn, and what comes from outside (a folder, a file name, a typed
target) is escaped for it (`ChatProvider.escape`, which the Slack provider answers with
`escape.mrkdwnEscape`). `!help`, `!guide`, `!status` and the answer to a
resume stay a markdown block at full size (`ThreadChat.say`): the first three are read, and a resumed
session's title keeps every character inside its bold only there, since mrkdwn has no escape for
`*`. A shorter target is read only as a title. The list holds the directory's own sessions, not
other worktrees', as the terminal's picker starts. A Resume click is checked like any other button,
and the session must still be one of the directory's. `!bind` alone lists, through
`folders.bindableFolders`, the folders where a session can start: `ALLOWED_ROOT`, then its folders,
then theirs (`folders.foldersWithin`), skipping hidden folders and symlinks and never descending
into a git repository (a `.git` directory or file). A folder is kept when the back end says the
owner trusted it (`AgentBackend.folderTrusted`). The checks run eight at a time
(`folders.TRUST_BATCH`) and stop once one more than the 20 rows shown (`folders.FOLDER_ROWS`) is
found, so the higher levels fill the rows, which are then shown in path order. The trust record is
parsed again only when its mtime or size changes. A Bind click is checked like any other button, its
folder goes through the same `directory.resolveDirectory` check as a typed `!bind <folder>`, a click
on the channel's own folder changes nothing, and a click while any of the channel's threads is not
idle is refused, as a typed `!bind` is. The `!resume` list reads the last message of a session's
transcript only while that session can still be among the 20 shown: a file's mtime bounds its last
message from above (`listing.byLastActivity`). The SDK dates a listed session by its transcript
file's mtime and names no path for a transcript, so the back end finds the folder's transcript
directory itself (`listing.projectFolder`): under `~/.claude/projects/`, or under
`CLAUDE_CONFIG_DIR` when that is set, in a directory named after the folder's real path (composed to
NFC on macOS) with every character that is not an ASCII letter or digit turned into `-`; past
`listing.LONG_PROJECT_KEY` (200) characters, the first 200, a `-` and a hash, and since that hash is
Claude Code's to compute, the first directory that starts with the same 200 characters and `-`
stands in for it. The rule is the one the SDK itself applies (measured: "Transcript folder name").
With no such directory the sessions keep their files' times, and a warning says so. Top-level
`!status` (`status.channelStatus`) lists the channel's directory, then one line per live session
of the channel, each a link to its thread labelled with the session's title (`Talk.referenceLink`),
busy, waiting for the owner or idle, with the time since its last message when idle, its running
tasks, its bypass and its folder when it differs from the channel's; while a stop waits, a notice
under it names the threads the stop waits for. Inside a thread `!status` is that session's own
(`ThreadSession.status`, see Footer above). Top-level `!stop` (`SessionManager.stopChannel`) and
`!bind`'s busy check (`SessionManager.sessionsOf`) both read the channel's live sessions the same
way. `commands.helpText` lists the daemon's own words, then, only when it is called with a session's
commands (never at the top level, where a word never has one), those the session's start reported
(`AgentSession.info`), keeping only the lines that contain the text after `!help` when there is one,
so a command a new Claude Code release adds needs no change here. Bolt's per-request authorization
returns the identity `auth.test` gave at startup and no token, so no request costs an extra API call
and Bolt builds no client of its own; its `ignoreSelf` filter and its conversation store are
switched off, and what Bolt logs goes to the daemon's log.
