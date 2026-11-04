/** The quick picks for a new meeting's title, each with a starter agenda the person can edit. */
export const MEETING_TEMPLATES = [
  { title: "Standup", agenda: "What shipped yesterday\nWhat's blocked\nWhat's next today" },
  { title: "Sprint planning", agenda: "Review the goal for the sprint\nPick the tickets and size them\nAgree what is out of scope" },
  { title: "Review", agenda: "Demo what merged\nWhat went well\nWhat to change" },
  { title: "Retro", agenda: "What went well\nWhat did not\nOne thing to try next" },
] as const;
