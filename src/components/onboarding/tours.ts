import type { Side } from "./placement";

/**
 * Every guided tour the ant gives, in the words it says them.
 *
 * Each step lights up whatever carries `data-tour="<target>"` (several
 * elements may share one target; up to five are lit at once). A step whose
 * target is not on screen, such as a desktop-only control on a phone, is
 * skipped rather than pointing at nothing.
 *
 * The first three tours run once each, in order, as a new person signs in,
 * picks a project and lands on the board. The rest each run the first time
 * their screen is opened.
 */

export interface TourStep {
  target: string;
  side: Side;
  title: string;
  text: string;
  /** The Next button's label. Defaults to "Next", or "Done" on the last step. */
  next?: string;
  /**
   * The step waits for the person to act on what is lit (signing in,
   * picking a project) instead of offering Next. Shown beside the buttons.
   */
  waitFor?: string;
}

export interface TourDef {
  id: TourId;
  steps: TourStep[];
  /** After the last step the ant walks back into the nest. */
  endInNest?: boolean;
  /**
   * Everything it points at is on screen when it starts, so a step whose
   * target is missing is left out from the start rather than waited for.
   * Off for tours of things that load in after they open.
   */
  allThere?: boolean;
}

export type TourId =
  | "login"
  | "pick"
  | "board"
  | "settings"
  | "timeline"
  | "sentinels"
  | "sentinel-report"
  | "chat"
  | "switch"
  | "ticket"
  | "agent"
  | "colony";

export const TOURS: Record<TourId, TourDef> = {
  login: {
    id: "login",
    steps: [
      {
        target: "login",
        side: "left",
        title: "Welcome",
        waitFor: "Sign in to carry on",
        text: "Hello hello! I'm your guide ant. First things first: please sign in with GitHub, so your agents can work on your repos as you.",
      },
    ],
  },

  pick: {
    id: "pick",
    steps: [
      {
        target: "examples",
        side: "left",
        title: "Pick a project",
        waitFor: "Pick one to carry on",
        text: "Now choose a project, or make a new one. First time here? The example project is the best place to experiment. Nothing you do there touches your own code.",
      },
    ],
  },

  board: {
    id: "board",
    endInNest: true,
    allThere: true,
    steps: [
      {
        target: "column",
        side: "inside",
        title: "The board",
        text: "This is your board. Work flows left to right: ideas land in Backlog, get planned in To Do, built in In Progress, checked in In Review, and finish in Done. In Formic, agents move the cards along. You steer.",
      },
      {
        target: "column-head",
        side: "below",
        title: "Column agents",
        text: "Each column has its own agent: Product, Architect, Coder, Reviewer and PM. The keys you set up are used to create the agents here. My advice? Keep the default prompt for now. It's a good one.",
      },
      {
        target: "account",
        side: "below",
        title: "You",
        text: "That's you. Your settings live in here.",
      },
      {
        target: "timeline",
        side: "below",
        title: "Timeline",
        text: "The timeline. Your epics laid out day by day, so you can see what shipped when.",
      },
      {
        target: "points",
        side: "below",
        title: "Points",
        text: "Points! Each merged ticket earns some, and quick merges in a row heat up for a bonus.",
      },
      {
        target: "sentinels",
        side: "below",
        title: "Sentinels",
        text: "The Sentinels. They audit your code and grade it. Your colony's level lives here too.",
      },
      {
        target: "chat",
        side: "below",
        title: "General chat",
        text: "The general chat. Ask anything about your project, any time.",
      },
      {
        target: "logo",
        side: "below",
        title: "Projects",
        text: "The Formic mark. Tap it to switch projects.",
      },
      {
        target: "first-ticket",
        side: "right",
        title: "Your first ticket",
        text: "Every new project starts with this ticket: write an AGENTS.md. It's a test ticket, so you can see how the app works from start to finish.",
      },
      {
        target: "colony",
        side: "above",
        title: "One more thing…",
        next: "See you inside",
        text: "Oh! One more thing. Down here is the colony, where your ants live. It grows every time you ship. Each screen has its own little tour, and I'll be waiting there. Bye for now!",
      },
    ],
  },

  agent: {
    id: "agent",
    steps: [
      { target: "agent-provider", side: "left", title: "Key", text: "Pick which of your keys this agent runs on." },
      { target: "agent-model", side: "left", title: "Model", text: "Then the model. Bigger thinks harder, smaller is quicker." },
      {
        target: "agent-prompt",
        side: "left",
        title: "Prompt",
        text: "This is its job description. The default is a good one, so leave it be for now.",
      },
      { target: "agent-save", side: "above", title: "Save", text: "Save, and this column's cards go to this agent." },
    ],
  },

  settings: {
    id: "settings",
    steps: [
      { target: "settings-github", side: "left", title: "GitHub", text: "Your GitHub link, and the repos Formic can reach." },
      { target: "settings-agents", side: "left", title: "Agents", text: "Your keys live here. Every column agent is made from one." },
      { target: "settings-sandbox", side: "left", title: "Sandbox", text: "Where agents run code, boxed up so nothing leaks out." },
      {
        target: "settings-auto-merge",
        side: "left",
        title: "Auto-merge",
        text: "Choose when work merges by itself. Auto-escalation, just below, decides when I should fetch you.",
      },
      { target: "settings-sharing", side: "left", title: "Sharing", text: "Share this board's keys with the people you work with." },
      {
        target: "settings-sound",
        side: "left",
        title: "Sound",
        text: "And if my voice gets too much, you can turn me down here. I won't be offended. Much.",
      },
      {
        target: "settings-guided-tours",
        side: "left",
        title: "Guided tours",
        text: "Miss me already? This brings every screen's tour back, for a refresher.",
      },
      { target: "settings-danger-zone", side: "left", title: "Danger zone", text: "Careful down here. This removes your account for good." },
    ],
  },

  timeline: {
    id: "timeline",
    steps: [
      {
        target: "timeline-chart",
        side: "inside",
        title: "Timeline",
        text: "Each row is an epic, laid out over the days it was worked on. Hover a day to see what happened.",
      },
      { target: "timeline-legend", side: "below", title: "Colours", text: "Grey is merged, terracotta is in review, ochre is in progress. Dashed is still planned." },
      { target: "timeline-nav", side: "below", title: "Earlier, later", text: "Step back through time with these." },
      { target: "timeline", side: "below", title: "Back to board", text: "Press this again to head back to the board." },
    ],
  },

  sentinels: {
    id: "sentinels",
    steps: [
      {
        target: "sentinels-roster",
        side: "inside",
        title: "The roster",
        text: "These are the Sentinels. Each one checks a different side of your code, and more unlock as you level up.",
      },
      { target: "sentinels-grade", side: "below", title: "Grade", text: "Together they give your project a grade. Stars from every Sentinel add up to it." },
      { target: "sentinels-summon", side: "below", title: "Audit", text: "Summon them all and watch them scan. Each one reports back." },
      { target: "sentinels", side: "below", title: "Back to board", text: "Tap the level badge again to head back." },
    ],
  },

  "sentinel-report": {
    id: "sentinel-report",
    steps: [
      {
        target: "sentinel-report",
        side: "left",
        title: "A report",
        text: "This is what a Sentinel found: its stars, what it checked, and what it would fix first.",
      },
    ],
  },

  chat: {
    id: "chat",
    steps: [
      {
        target: "chat-shade",
        side: "below",
        title: "General chat",
        text: "Answers roll down from the top, like a blind. It knows your board and your code. Roll it up when you're done.",
      },
      {
        target: "logo",
        side: "below",
        title: "Elsewhere",
        text: "An answer from another project shows up as a little number on the Formic mark.",
      },
    ],
  },

  switch: {
    id: "switch",
    steps: [
      { target: "switch-search", side: "right", title: "Search", text: "Find a repo, or type owner/repo. Type a new name and I'll make the repo on GitHub for you." },
      { target: "examples", side: "right", title: "Example", text: "The example project is always here, if you want somewhere safe to play." },
      { target: "switch-boards", side: "right", title: "Your boards", text: "Each repo has its own board, agents and colony." },
    ],
  },

  ticket: {
    id: "ticket",
    steps: [
      { target: "ticket-body", side: "right", title: "The ask", text: "What needs doing, and how we'll know it's done. The files the agent may touch are listed too." },
      { target: "ticket-agent", side: "left", title: "The agent", text: "Talk to the agent working on it, right here. Its plan and progress show up as it goes." },
    ],
  },

  colony: {
    id: "colony",
    steps: [
      { target: "colony-rank", side: "left", title: "Home", text: "Welcome to my place! This is your colony's level and rank. Scout first, Queen one day." },
      { target: "colony-next", side: "left", title: "Levels", text: "Points fill this bar. Every level unlocks something new." },
      { target: "colony-shapes", side: "left", title: "Bug shapes", text: "New levels unlock new shapes for your bugs." },
      { target: "colony-colours", side: "left", title: "Bug colours", text: "And new colours. Pick one to try it out." },
    ],
  },
};
