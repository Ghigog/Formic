# 

Product Requirements Document: Autonomous Agent Kanban Web App

## **1\. Executive Summary**

This document outlines the product requirements, value proposition, and initial engineering tickets for an end-to-end, AI-native Kanban web application. The platform orchestrates autonomous coding agents through the entire software development lifecycle—from conceptualization (PRD generation) and ticket breakdown, to isolated code execution, automated PR review, conflict resolution, and async user showcasing. By encapsulating these steps within a responsive web application, the tool empowers users to build and scale software efficiently across any OS or mobile device.

## **2\. Value Proposition**

> * **Unified Orchestration:** Eliminates the fragmentation of gluing together issue trackers (Linear/Jira), local IDE agents (Cursor/Claude Code), CI pipelines (GitHub Actions), and deployment previews (Vercel).  
> * **Concurrency by Design:** Natively handles dependency management and file-collision boundaries, allowing multiple agents to work on the same Epic simultaneously without catastrophic merge conflicts.  
> * **Automated Lifecycle Management:** Reduces human intervention to high-level steering (Backlog) and final approval (Showcase), automating the tedious middle layers of PRDs, ticket writing, syntax fixing, and rebasing.  
> * **Universal Accessibility:** Designed as a responsive web app, allowing founders and PMs to manage complex software builds from a tablet or mobile device.

## **3\. Core Workflow (The Agentic Loop)**

The core user experience revolves around dragging cards across a Kanban board, where specific column transitions trigger sandboxed backend operations.

> 1. **Backlog (Ideation):** The user inputs a raw feature request. A "Product Agent" expands this into a structured Epic/PRD containing the required technical context.  
> 2. **To Do (Decomposition):** An "Architect Agent" breaks the Epic down into granular tickets. It generates a Directed Acyclic Graph (DAG) to map dependencies and isolates file scopes to enable safe concurrent execution.  
> 3. **In Progress (Execution):** The platform spins up ephemeral sandboxes (e.g., Docker containers or micro-VMs). "Coder Agents" (powered by Claude 3.5 Sonnet) write code, run local tests, and push branches to the connected Git repository.  
> 4. **In Review (CI/CD & Merge):** A "Reviewer Agent" monitors the Pull Request. If tests fail, it feeds logs back into an autonomous fixing loop. It handles rebasing against the main branch, resolves conflicts, and executes the merge.  
> 5. **Done (Showcase):** Once all tickets in an Epic are merged, a "PM Agent" aggregates the diffs and preview URLs to generate an async step-by-step showcase for the user.

## **4\. Minimal Viable Product (MVP) Scope**

To validate the core loop, the MVP will constrain certain edge cases to focus on end-to-end functionality.

> * **Single Project Context:** Hardcode or uniquely configure the system to operate against a single designated GitHub repository (e.g., a Next.js boilerplate).  
> * **Sequential Merging (V1 Concurrency):** While the Coder Agents can work in parallel, the Reviewer Agent will strictly merge one PR at a time, enforcing an automated \`git pull \--rebase\` before the next merge to handle basic conflicts.  
> * **Mock Sandbox Execution:** Initial prototype will run agents using a managed execution environment like E2B (Code Interpreter) or basic local child-processes before scaling to custom Docker infrastructure.  
> * **Basic Showcase:** The MVP showcase will consist of an aggregated Markdown summary of changes and a unified list of updated files, rather than a fully interactive UI tour.

## **5\. Technical Architecture Proposal**

> * **Frontend Web App:** Next.js (App Router), Tailwind CSS, React DnD (or \`@hello-pangea/dnd\`) for the responsive Kanban board.  
> * **Backend API:** Next.js API Routes or a lightweight Node.js/Express server.  
> * **Agent Orchestration & State:** Temporal.io or Inngest to manage long-running background agent loops and ensure durability (retries, timeouts).  
> * **LLM Provider:** Anthropic API (Claude 3.5 Sonnet) for code generation, PRDs, and reviewing.  
> * **Execution Sandbox:** E2B Sandboxes or Modal for ephemeral, secure code execution and Git operations.

## **6\. Prototype Implementation Tickets**

These tickets represent the initial sprint required to build the MVP.

| Ticket ID | Title | Description | Dependencies |
| :---- | :---- | :---- | :---- |
| PROT-01 | Setup Next.js Frontend & Kanban UI | Initialize Next.js project. Implement a responsive, 5-column Kanban board (Backlog, To Do, In Progress, In Review, Done) using \`@hello-pangea/dnd\`. Create mock UI state. | None |
| PROT-02 | Integrate Database & State Persistence | Set up a database (e.g., PostgreSQL via Supabase or Prisma) to persist board state, tickets, Epics, and column positions. | PROT-01 |
| PROT-03 | Build Backlog "Product Agent" Pipeline | Create a backend endpoint triggered when a card is added to the Backlog. Connect to the Anthropic API to take a raw string and return a formatted Epic PRD. Update UI with the result. | PROT-02 |
| PROT-04 | Build To Do "Architect Agent" Pipeline | Triggered on Epic move to 'To Do'. Send the Epic PRD to the LLM with a strict JSON schema prompt to return an array of child tickets with specific file scopes and dependency links. | PROT-03 |
| PROT-05 | Setup E2B Sandbox Environment | Integrate the E2B SDK. Create a service capable of spinning up a sandbox, cloning a target GitHub repository using a PAT, and returning connection status. | None |
| PROT-06 | Implement "Coder Agent" Execution Loop | Triggered on ticket move to 'In Progress'. Send ticket details to LLM to generate bash/code commands. Execute commands in E2B sandbox. Run tests, commit, push branch, and open PR via GitHub API. | PROT-04, PROT-05 |
| PROT-07 | Implement Webhook & "Reviewer Agent" | Listen for GitHub PR webhooks. If tests fail, send CI logs to LLM for a fix commit. If passed, execute \`git rebase main\` and merge via GitHub API. Move ticket to 'Done'. | PROT-06 |
| PROT-08 | Implement Epic "Showcase" Aggregator | When all child tickets of an Epic hit 'Done', trigger a final LLM call summarizing the merged PR diffs into a coherent changelog/showcase document attached to the Epic UI. | PROT-07 |

