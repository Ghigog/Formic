# Craft and direction: making the colony care about the result

**Status:** in progress. Started 2026-10-30. Tick boxes as work lands; this file is
the memory of the plan, so keep it current.

**Original requests:** #980 (bells), #981 (calls), #982 (board swap). Their
first quoted block is the person's own words; the rest is the Product Agent's PRD.

## Why

Three Epics went through the full pipeline (PRD, tickets, code, review) and all
three shipped short of what was asked, off-theme and partly broken. The
investigation found the agents did what they were written to do.

### The prompts tell every agent to do the least and never ask

From `src/lib/agents/prompts.ts`:

- Product: "Do not invent product surface the request does not imply." and "Do
  not list open questions … where the request is ambiguous pick the obvious
  reading and state it in one line."
- Coder: "make the smallest change that satisfies every acceptance criterion."
- Reviewer: "Keep the board moving: your job is to catch what would break, not
  to polish."

So the Product Agent was forbidden to ask, and forbidden to imagine. "Drag the
bell side to side" stayed a drag on an icon; nobody reached for the string, the
swing, the sound.

### Nobody owns the outcome

Each agent checks its work only against the step before it. The request becomes
a PRD, the PRD tickets, the tickets code. Intent decays at every handoff, and no
agent ever looks back at the person's words or at how the feature feels in a
hand. The PM sits in Done writing a showcase.

### Nobody holds the taste

No prompt or ticket cites `design/DESIGN.md` or the UI/UX philosophy. The
Designer Sentinel unlocks at level 25. Features come out generic.

### Plumbing that made it worse

- **Stale stacked branches.** EPIC-167-T4 stacked on T1's branch, cut before T2
  (three-finger swipe, right-drag) and T3 (dig transition) merged. Its worker
  wrote "The gesture did not exist yet, so I defined it" and invented a pull-down
  tab and Alt+arrow (out of scope). T2 and T3 are merged and unused.
- **Review against the ticket only.** The reviewer approved the invented tab
  because the ticket's criteria passed.
- **No real browser.** Unit tests only; the one e2e test was never run.

### What a person saw

| Feature | Asked | Shipped |
| --- | --- | --- |
| Board swap | Three-finger swipe, dig through the earth | A tab at the top that covers the header and fights the phone's own bar; a 96px pulsing strip for dirt |
| Bell | Ring by swinging it, to avoid misclicks | An icon button, disabled below level 5 so the free silver bell cannot ring at all; no swing, no sound |
| Calls | Quick answers, "let me get back to you" only when a lookup runs long (~5 s) | Claude Code guests answer "I'll get back to you." to everything, before thinking (`src/lib/calls/turn.ts:283`); API guests wait 30 s; only the last message is seen; no personas |

## Decisions (from the person, 2026-10-30)

- **Questions are their own kind of notice**, beside warnings (red, failed) and
  alerts (yellow, waiting for you). Work waits on a question when it depends on
  the answer, which is most of the time; otherwise the agent carries on with a
  stated assumption.
- **The PM is the director.** It steps into card chats on its own. Its job:
  make sure each column's agent does its job and follows the standards (the
  original request, the PRD, the design doc, testing). It takes agents'
  questions and passes them to the person in plain, non-technical words, and
  carries the answer back.
- **The PM replaces the general assistant** in the top bar, keeping the
  assistant's powers (board changes still wait as proposals for approval).
- **Build directly**, not through Formic's own pipeline, since the pipeline is
  what is being fixed.

## The work

### 1. Craft in the prompts

- [x] Rewrite the Product brief: read the intent behind the words, find the
      version the person did not know they wanted (the string on the bell), say
      what was added and why. (Interviewing before a PRD comes with step 2.)
- [x] The person's original words reach the Architect, the Coder and the
      Reviewer (`src/lib/agents/origin.ts`), so nothing fades in handoff.
- [x] Architect: tickets that touch the UI cite the design doc and describe how
      the thing looks and feels (motion, sound, feedback), not only behaviour.
- [x] Coder: "smallest change" becomes "the right change, finished": craft,
      polish and feel are part of done for anything a person touches.
- [x] Reviewer: judge against the original request, the PRD and the design doc
      as well as the ticket. A feature that passes its tests but would
      disappoint the person is sent back.
- [x] Keep the cost rules that do not cost quality (checkpointing, verify
      once, scope locks).

A shared `DESIGN_RULE` now reaches the Product, Architect, Coder and Reviewer
prompts, custom or not.

### 2. Questions as a first-class part of Formic

- [ ] A `question` notice severity, with its own mark (not red, not yellow) on
      cards and in the drawer.
- [ ] An `ask_question` action for every agent in every column: the question,
      why it matters, whether the work waits on it, and the assumption it takes
      if not.
- [ ] A waiting question pauses the card; the person answers in the card's chat
      and the answer resumes the work.
- [ ] Product Agent interviews before a PRD: at most two or three sharp
      questions, only where the answer changes the product.
- [ ] Agents can ask to propose follow-up work.
- [ ] Open questions gather in one place (the PM chat), so they read as a
      conversation, not a pile of alerts. Push notification on a new question.

### 3. The PM as director

- [ ] The top-bar chat becomes the PM's chat, with the assistant's tools and
      proposals.
- [ ] On every column move, the PM checks the card against the original
      request, the PRD and the design doc, and steps into the card's chat when
      it drifts.
- [ ] The PM relays agents' questions to the person in plain words and carries
      answers back into the card.
- [ ] The PM asks the person about priorities when work goes off track.
- [ ] Every PM intervention shows in the card's chat, signed by the PM.
- [ ] The showcase stays, written by the PM when an Epic ships.

### 4. Design as a first-class part of the board

- [ ] A second onboarding ticket beside AGENTS.md: the person describes the
      look and feel in its chat; agents refine it into `DESIGN.md` (a design
      philosophy doc) in the repository.
- [ ] The Designer Sentinel unlocks early (level 2 or 3) and grades two things:
      how closely shipped features match the doc, and how good the doc is.
- [ ] Frontend tickets cite the doc; the reviewer checks against it.
- [ ] Later, not now: Figma and atomic components from designs.

### 5. Plumbing

- [ ] A stacked ticket's branch takes in every prerequisite merged since it was
      cut, before its agent starts.
- [ ] A ticket whose work needs a sibling's code waits for that sibling, not
      only for its declared dependency.
- [ ] A real browser test runs for anything a person touches, and its result
      counts in review.

### 6. Rebuild the three features to the new standard

**Bell.** A bell hanging from a string in the colony popover. Pull the string
down and swing it side to side: the bell swings with real weight, rings with a
sound and a little shake of the popover, and only a full swing rings it. A
tap does nothing but nudge it, so no misclick ever rings it. The free silver
bell works at every level. Arming a golden bell turns it gold with a soft
glint; the count of golden bells sits beside it. Formic's tokens, type and
motion throughout.

**Board swap.** Wire in the existing three-finger swipe and right-button drag
(`swap-gesture.ts`) and the dig transition (`dig-transition.tsx`). Remove the
top tab and Alt+arrow. The dirt band fills the view, textured in the colony's
earth, with small stones and roots passing as it scrolls. The next board's name
shows faintly in the soil while it loads. Verified in a real mobile browser.

**Calls.** Answer like a person on a call: fast for greetings and obvious
things; "let me get back to you on that" only when a lookup runs past about five
seconds, and then the answer arrives in the call. Claude Code guests answer
quick turns through an API path and use Actions only for deep work. Guests see
the whole call, and speak in their own voices (the Sentinels' personas, the
column agents' manners).

## Order

1, then 2 and 3 together (the PM relays questions), then 4, 5, and 6. Each
step lands as its own commit on `claude/formic-features-review-dhp0bn` with its
tests passing.
