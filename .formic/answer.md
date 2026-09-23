{
  "title": "Add To Do ticket requests, agent triage between columns, and attachments",
  "prd": {
    "summary": "Today, every request starts in Backlog: the \"New request\" button creates an Epic, and the Product Agent drafts a PRD for it. This Epic adds a second \"New request\" button in the To Do column. A request made there becomes one ticket that the To Do column's agent writes directly, with no Epic and no PRD. Each column's agent triages what it is given. The Backlog agent can decide a request is small enough for a single ticket and send it to To Do. The To Do agent can decide a request is too big for one ticket and send it to Backlog as an Epic. Either way, the user is told what moved and why. Both New request dialogs also accept attachments (images, photos and other files), and the agents that handle the request can read them.",
    "problem": "Every request has to go through an Epic, a PRD and a DAG breakdown. For a small change, such as a one-line fix or a copy tweak, that is slow and costs tokens for nothing. People have no way to say \"this is just a ticket\". People also pick the wrong entry point: a large feature typed as a ticket, or a trivial fix typed as an Epic. Nothing catches that. And a request can only be text, so a screenshot of a bug, a mockup or a spec file cannot go with it, even though these often explain the request better than words.",
    "scope": [
      "Add a \"New request\" button to the To Do column, in the same style and position as the Backlog one. It opens the request dialog in ticket mode: the title and submit label say a ticket is being written, not a PRD being drafted.",
      "A ticket request creates one ticket in To Do that belongs to no Epic. The To Do column's agent (the Architect role, or whatever preset is assigned to To Do) turns the raw request into a single ticket: a title, a description, acceptance criteria, a file scope, a size and story points. The ticket then becomes ready.",
      "The ticket stays visible in To Do while its agent works on it, shows that the agent is working, and stalls with a visible reason if the agent fails. This matches how an Epic behaves while its PRD is being drafted.",
      "Backlog triage: when the Backlog agent reads a new request, it decides whether the request needs an Epic. If one ticket is enough, the request becomes a ticket in To Do, written by the To Do agent, and no PRD is drafted.",
      "To Do triage: when the To Do agent reads a new ticket request, it decides whether one ticket is enough. If the request needs an Epic, it is sent to Backlog as an Epic that keeps the original raw request and attachments, and the Product Agent drafts its PRD as usual.",
      "Whenever triage moves a request, the user is told. The moved card shows which column it came from and the agent's one- or two-sentence reason. The card updates live over the event stream, without a page reload.",
      "A request is moved at most once. Once triage has sent a request to another column, the receiving agent does not send it back.",
      "Attachments in both New request dialogs: the user can add images and photos (including taking one with the camera on mobile) and other files. They can choose files, drag and drop them, or paste them. Each attachment appears as a removable chip, with a thumbnail for images, before submitting.",
      "Attachments are validated on the server: a limit on file size, a limit on the number of files per request, and a list of allowed file types. A rejected file gives a clear error in the dialog, and the text of the request is not lost.",
      "Attachments are stored with the request and follow it wherever it goes: an Epic, a standalone ticket, or a card moved by triage. They are listed in the Epic drawer and the Ticket drawer, where they can be opened or downloaded.",
      "The agents that read the raw request can use its attachments: the Product Agent drafting a PRD, the To Do agent writing a ticket, and both triage decisions. Images are sent as images to models that accept them. Text files are sent as text. Other files are at least named, so the agent knows they exist."
    ],
    "outOfScope": [
      "New request buttons in In Progress, In Review or Done.",
      "Adding attachments after creation. Attachments are added only when the request is made, in the New request dialog.",
      "Editing or annotating images, and previewing file types other than images inside Formic (other files are downloaded).",
      "Having a standalone ticket join an existing Epic, or grouping standalone tickets under an Epic after the fact.",
      "Dependencies between standalone tickets and other tickets. A standalone ticket has no dependencies.",
      "Triage anywhere other than when a request is created: no re-triage when a card is dragged, no triage of existing cards, and no splitting one request into several.",
      "A user confirmation step before triage moves a request. The agent moves it and says why; a person who disagrees can drag the card back.",
      "Passing attachments to the Coder or Reviewer agents, or committing them to the repository.",
      "Syncing attachments to the GitHub issue for the card.",
      "The Assistant creating tickets or accepting attachments.",
      "Scanning uploads for viruses, running OCR, or transcoding images."
    ],
    "technicalContext": [
      "The Backlog entry point today: NewRequestButton in src/components/board/board.tsx is rendered only for col === \"backlog\". It opens NewItemDialog (src/components/board/new-item-dialog.tsx), which posts rawRequest to POST /api/epics (src/app/api/epics/route.ts). That route calls createBacklogItem in src/lib/board/service.ts, which creates the Epic and launches runProductAgent.",
      "Tickets cannot exist without an Epic today. Ticket.epicId is required in prisma/schema.prisma and in ticketSchema (src/lib/domain/entities.ts), with @@unique([epicId, key]), and BoardCard.epicId is nullable only for epics. A standalone ticket needs either a nullable epicId, which means ticket keys must be unique per project rather than per Epic, or another explicit model. Decide this in the first ticket, because everything else depends on it.",
      "The board layout (src/components/board/placement.ts, layout()) groups tickets under their Epic, and the drawers assume every ticket has a parent Epic (the TicketDrawer's onOpenEpic). Both must handle a ticket with no Epic.",
      "Each column's agent is resolved per column through the preset system (src/lib/agents/presets.ts, resolveColumn and agentFor/cliAgentFor). Backlog runs the product role and To Do runs the architect role. The To Do column's custom preset should be used for ticket writing and triage too, not only for DAG breakdown.",
      "Agent ports (src/lib/agents/ports.ts): ProductAgent.draftPrd takes { epicId, rawRequest }, and ArchitectAgent.decompose takes a PRD. Ticket writing and triage need new input and output shapes, including attachments and a routing decision with a reason. Implementations exist in anthropic.ts, openai-agents.ts, mock.ts and the CLI runner path (src/lib/runner). All of them need the new inputs, and mock.ts must support tests of both triage outcomes.",
      "Ticket validation in the DraftTicket port and in ticketSchema already requires at least one fileScope entry and allows at most 12. A standalone ticket must meet the same contract, so the Coder's scope enforcement still holds.",
      "Where triage's reason can show: BoardCard already has misplacedIn/misplacedReason and blockedReason, which are shown on the card. Triage's reason is a different thing and should not reuse them, because a card moved by triage is not misplaced.",
      "There is no file storage today, and the app deploys to Vercel (vercel.json), so the local filesystem cannot hold attachments. CLI agents run in GitHub Actions (formic-agent.yml, src/lib/runner), so attachments must be reachable from there as well as from API agents. Choose the storage backend before building attachments.",
      "Events are published through src/lib/events/bus.ts and the client picks them up in use-board-events.ts. The event for a move made by triage must say where the card came from and why.",
      "Create routes validate their bodies with zod. The current body is JSON with rawRequest limited to 4000 characters. Uploading attachments means changing these routes to accept multipart data or adding a separate upload step."
    ],
    "userStories": [
      "As a developer, I'd like to type a small change straight into To Do, so that it becomes a ready ticket without waiting for a PRD and a DAG breakdown.",
      "As a developer, I'd like the Backlog agent to notice when my request is really a single ticket, so that I don't spend time and tokens on an Epic I don't need.",
      "As a developer, I'd like the To Do agent to notice when my ticket request is really a feature, so that it gets a proper PRD and breakdown instead of one oversized ticket.",
      "As a developer, I'd like to see where a request was moved and why, so that I can trust the decision or drag the card back if I disagree.",
      "As a developer reporting a bug, I'd like to attach a screenshot or photo to my request, so that the agent can see the problem instead of reading my description of it.",
      "As a product owner, I'd like to attach a mockup or spec file to a feature request, so that the PRD is based on the material I already have.",
      "As a developer, I'd like to open a card's attachments from its drawer, so that I can check what the agent was given."
    ],
    "successCriteria": [
      "Given the board, when the To Do column renders, then it shows a \"New request\" button, and the In Progress, In Review and Done columns do not.",
      "Given the To Do New request dialog, when the user submits a request that fits in one ticket, then a ticket card with no parent Epic appears in To Do, and once its agent finishes it has a title, a description, acceptance criteria, a file scope and a size, and its status is ready.",
      "Given the To Do agent fails on a ticket request, when the run ends, then the card stays in To Do as blocked, with a reason the user can read.",
      "Given the Backlog New request dialog, when the user submits a request the Backlog agent judges to be one ticket, then no PRD is drafted, the card ends up as a ticket in To Do, and it shows that it came from Backlog and the agent's reason.",
      "Given the To Do New request dialog, when the user submits a request the To Do agent judges to need an Epic, then an Epic with the original raw request appears in Backlog, the Product Agent drafts its PRD, and the card shows that it came from To Do and the agent's reason.",
      "Given a request moved by triage, when the receiving agent runs, then the request is not moved again.",
      "Given a request moved by triage, when the move happens, then everyone with the board open sees the card in its new column without reloading.",
      "Given either New request dialog, when the user adds an image by choosing a file, dragging it in or pasting it, then a thumbnail chip appears that can be removed before submitting.",
      "Given either New request dialog on a mobile device, when the user adds an attachment, then they can take a photo with the camera.",
      "Given a file that is too large, of a type that is not allowed, or beyond the per-request limit, when the user adds it or submits, then the dialog shows an error naming the file and the text of the request is kept.",
      "Given a request submitted with attachments, when its Epic drawer or Ticket drawer is opened, then every attachment is listed and can be opened or downloaded, including after triage has moved the request.",
      "Given a request with an image attachment, when the Product Agent or the To Do agent runs on it with a model that accepts images, then the image is part of the agent's input.",
      "Given a request with no attachments made in Backlog and judged to need an Epic, when it is submitted, then it behaves as it does today: an Epic in Backlog with a PRD drafted by the Product Agent."
    ]
  }
}
