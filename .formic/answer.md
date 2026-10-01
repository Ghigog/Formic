{
  "key": "T-1",
  "title": "Let owners set exact run time budget values, with sensible limits that are enforced",
  "userStory": {
    "as": "a board owner",
    "want": "type the exact minutes for each run time budget mode and be told when a value cannot be honoured",
    "soThat": "agents are held to the time I intend and I am never surprised by a silent cap or fallback"
  },
  "context": "Settings > Run time budget lets me pick a mode (Off, Flat minutes, Per story point, Per-point values) but Per story point has no input: it is fixed at 10 minutes per point. Values have no upper bound, though a loop run is silently clamped to the job ceiling (55 minutes) by loopBudgetMs, and Per-point values silently fall back to 10 x points for any story point size not listed. The screenshot attached to the request could not be downloaded (sign-in required), so this is based on the code.",
  "description": "Review the run time budget section end to end and make every mode accept the value that defines it, validate it against common-sense rules, and show the ceiling that will really apply. The stored settings, the validation and the value a run receives must agree.",
  "requirements": [
    "Add a perStoryPointMinutes setting (whole minutes, default DEFAULT_MINUTES_PER_STORY_POINT) used by PER_STORY_POINT in resolveRunTimeBudget; show a 'Minutes per story point' input when that mode is selected. Persist it via a new nullable column on User (prisma migration) and the db repository, user-settings mapping and /api/settings route, clearing it when the mode does not use it.",
    "Extend validateRunTimeBudgetSettings (shared by the form and the API route, so client and server cannot disagree): whole numbers >= 1 for flat, per-point rate and per-point values; a maximum of the loop ceiling (the runner's job minutes less headroom, exported from one place rather than duplicated); per-point story points must be Fibonacci sizes 1,2,3,5,8,13; the per-point rate x 13 is not rejected but the form shows the effective ceiling.",
    "Make the per-point fallback visible: the Per-point values blurb and a preview line state that sizes not listed use rate x points, and show the resulting minutes for each size, marking any that the ceiling will cap (e.g. '13 points: 130 min, capped to 55').",
    "Keep resolveRunTimeBudget and loopBudgetMs agreeing: a saved setting that passes validation resolves to exactly that many minutes; anything above the ceiling is rejected on save rather than clamped silently. Existing stored values above the ceiling still resolve and are clamped, and the form shows a warning for them.",
    "Tests first at the lowest level: unit tests for resolveRunTimeBudget (rate mode) and validateRunTimeBudgetSettings (bounds, Fibonacci, decimals, zero, blank); component tests for the section (input per mode, error text, preview and cap note); a route test for PUT /api/settings rejecting an out-of-range value with the same messages. No e2e test."
  ],
  "acceptanceCriteria": [
    {
      "given": "the mode is Per story point",
      "when": "I enter 15 minutes per story point and save",
      "then": "the value is stored and a 3-point ticket's run is given 45 minutes"
    },
    {
      "given": "the mode is Flat minutes",
      "when": "I enter 0, 2.5, blank or a number above the ceiling and save",
      "then": "nothing is saved and a message beside the field says what is allowed"
    },
    {
      "given": "the mode is Per-point values",
      "when": "I add a row for 4 story points, or two rows for the same size",
      "then": "the save is rejected with a message that sizes must be 1, 2, 3, 5, 8 or 13 and appear once"
    },
    {
      "given": "Per-point values has only a 1-point row",
      "when": "I look at the section",
      "then": "it shows the minutes a 2, 3, 5, 8 and 13 point ticket will get from the per-point rate, and flags any capped by the ceiling"
    },
    {
      "given": "a request to PUT /api/settings carries an invalid value",
      "when": "the route validates it",
      "then": "it responds 400 with the same field errors the form shows and stores nothing"
    }
  ],
  "fileScope": [
    "src/lib/run-time-budget",
    "src/components/settings",
    "src/lib/user-settings",
    "src/app/api/settings",
    "src/lib/runner",
    "src/lib/db",
    "prisma"
  ],
  "storyPoints": 5,
  "dependsOn": []
}
