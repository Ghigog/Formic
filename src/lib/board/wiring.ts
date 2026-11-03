import "server-only";

import { registerBoardPorts } from "@/lib/board/ports";

/**
 * The one place the board's ports meet the real pipelines and service.
 *
 * Each port loads its implementation on first call, so importing this module
 * costs nothing and starts nothing, and a test that mocks a pipeline module
 * gets the mock. Imported by src/instrumentation.ts and the test setup.
 */
registerBoardPorts({
  coder: {
    runCoderAgent: async (...args) => (await import("@/lib/coder/pipeline")).runCoderAgent(...args),
  },
  review: {
    reviewPullRequest: async (...args) => (await import("@/lib/review/pipeline")).reviewPullRequest(...args),
    completeEpic: async (...args) => (await import("@/lib/review/pipeline")).completeEpic(...args),
    startShowcase: async (...args) => (await import("@/lib/review/pipeline")).startShowcase(...args),
    mergeByPerson: async (...args) => (await import("@/lib/review/pipeline")).mergeByPerson(...args),
  },
  service: {
    applyTransition: async (...args) => (await import("@/lib/board/service")).applyTransition(...args),
    redraftTicket: async (...args) => (await import("@/lib/board/service")).redraftTicket(...args),
    retryEpic: async (...args) => (await import("@/lib/board/service")).retryEpic(...args),
    deleteEpic: async (...args) => (await import("@/lib/board/service")).deleteEpic(...args),
    createBacklogItem: async (...args) => (await import("@/lib/board/service")).createBacklogItem(...args),
    advanceQueens: async (...args) => (await import("@/lib/board/service")).advanceQueens(...args),
  },
});
