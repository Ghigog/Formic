# **Formic: UI/UX Design Philosophy & Specification**

**Target Reader:** Lead Product Designer / UI/UX Specialist

**App Name:** Formic (from *Formicidae*)

**Core Purpose:** An autonomous agent Kanban platform that orchestrates software builds from raw backlog ideas to merged PRs and async feature showcases.

## **1\. Brand Identity & Core Metaphor**

Formic’s design is built on two core concepts: **The Ant Colony** and **The Eight of Pentacles**.

* **The Ant Colony (*Formicidae*):** Represents micro-specialized, highly disciplined parallel labor. Rather than an all-in-one assistant, Formic behaves like a colony: discrete agents handle specific tasks (Product, Architecture, Coding, Review) along defined lanes without collateral damage.  
*   
* **The Eight of Pentacles:** Represents disciplined, high-velocity craftsmanship and coin-minting precision.  
*   
* **Design Motto:** *Constrained Speed, Surgical Execution, Tactile Intelligence.*  
* 

The interface must avoid cold, hyper-futuristic sci-fi tropes (glowing neon blues, pitch-black dark rooms). Instead, it should feel like a warm, highly organized digital workbench—editorial, precise, and deeply grounding.

## **2\. Color Palette & Surface Tokens**

Formic uses an earth-and-fire color system, balancing warm parchment surfaces with energetic burnt-amber accent points.

### **Primary Brand Palette**

* **Terracotta Amber (**\#D96B27**):** The primary action token. Used for primary CTA buttons, drag handles on active cards, and main system highlights.  
*   
* **Clay Ochre (**\#C27803**):** The active agent token. Represents processing state, pheromone dependency trails, and active sandbox execution.  
*   
* **Deep Anthracite (**\#1C1917**):** Primary text in light mode / dark mode card container surface.  
*   
* **Parched Cream (**\#FBF9F5**):** Light mode background surface. Gives the app a warm, paper-like workbench feel.  
* 

### **Status Tokens**

* **Jade Green (**\#2E7D32**):** PR Merged, Tests Passing, Done state.  
*   
* **Rust Orange (**\#E65100**):** Rebase in progress, conflict resolving, retry loop.  
*   
* **Crimson (**\#C62828**):** CI Test Failure, build error, agent blocked.  
* 

## **3\. Typography & Spatial Grid**

### **Typography Hierarchy**

* **Primary Sans (UI & Structure):** Plus Jakarta Sans or Inter (Font weight 500 for cards, 600 for column headers).  
*   
* **Editorial Serif (Showcases & Epic Headers):** Newsreader or Söhne Serif (Gives PRDs and showcase walkthroughs a human, product-first feel).  
*   
* **Monospace (Logs, Code, & Metadata):** Geist Mono or JetBrains Mono (Used for Git commit hashes, ticket IDs, model tags, and live terminal execution streams).  
* 

### **Spatial Grid & Density**

* **8px Spatial Grid:** All paddings, margins, and component dimensions must align strictly to multiples of 8px (8, 16, 24, 32, 48).  
*   
* **Compact Data Density:** Information should be dense yet readable. Padding within cards should be tight (12px padding) to allow maximum vertical card visibility within columns.  
* 

## **4\. Key Visual Motifs & Custom Components**

### **A. Octagonal Coin Badges (The 8-Motif)**

Instead of standard rounded status pills, all ticket metadata (ticket size, model type like Sonnet 3.5, or complexity weight) must be framed in subtle **8-sided octagonal badges** with a 1px border (\#E7E5E4).

### **B. Pheromone Dependency Trails (DAG Lines)**

When an Epic is split into child tickets in the "To Do" column, tickets with blocking dependencies display subtle, curved vector connector lines (Clay Ochre \#C27803) when hovered. When a parent ticket moves to "Done", its connecting trail pulses briefly and unlocks the child ticket visually.

### **C. The 8-Stage Step Indicator**

Inside every Epic card drawer, a progress stepper displays the 8 lifecycle stages:

1. *Prompt* → 2\. *PRD Draft* → 3\. *DAG Breakdown* → 4\. *Sandbox Mint* → 5\. *Code Run* → 6\. *PR Opened* → 7\. *Rebase & Merge* → 8\. *Async Showcase*.  
2. 

### **D. The Ambient Agent Drawer**

A persistent, collapsible bottom bar across the web app showing:

* Active running sandboxes (e.g., "3 Agents active in E2B").  
*   
* Live token usage / execution speed.  
*   
* Quick-toggle terminal view to see real-time git commit and npm test streams.  
* 

## **5\. UI Layout & Key Screens for Mockup**

### **Screen 1: The 5-Column Kanban Board (Main View)**

* **Header Bar:** Project selector dropdown, repository status indicator (main branch sync tag), "New Backlog Item" button (\#D96B27), and overall Epic completion progress bar.  
*   
* **Columns (Horizontal Board):**  
* 

  1. **Backlog (Ideation):** Raw user feature inputs and generated Epics.  
  2.   
  3. **To Do (Decomposition):** Parent Epics with expandable accordions showing child tickets awaiting execution.  
  4.   
  5. **In Progress (Execution):** Active cards with animated pulsating clay borders, assigned agent badges, and live progress bars (e.g., "Writing tests...").  
  6.   
  7. **In Review (CI & Merge):** Tickets with linked GitHub PR badges, CI run status indicators, and rebase flags.  
  8.   
  9. **Done (Showcase Ready):** Merged tickets categorized under their parent Epic, with a "View Showcase" CTA button.  
  10. 

### **Screen 2: Epic PRD & Breakdown Drawer (Card Click)**

* **Layout:** Dual-pane modal/drawer.  
* 

  * **Left Pane (PRD Document):** Formatted in editorial serif typography (Newsreader). Includes scope, tech requirements, and user stories generated by the Product Agent.  
  *   
  * **Right Pane (Child Ticket DAG):** Visual tree of generated child tickets showing file-boundary isolation rules (e.g., "Agent 1 limited to /components/ui").  
  * 

### **Screen 3: Live Agent Sandbox Inspector (In Progress State)**

* **Layout:** Slide-over drawer when an "In Progress" card is selected.  
*   
* **Elements:**  
* 

  * Active E2B container status indicator.  
  *   
  * Embedded terminal streaming raw CLI logs (Geist Mono).  
  *   
  * Real-time file diff viewer showing code edits as the agent writes them.  
  * 

### **Screen 4: Async Feature Showcase View (Epic Completion)**

* **Layout:** Clean, presentation-ready document modal that appears when an entire Epic hits "Done".  
*   
* **Elements:**  
* 

  * Step-by-step feature walkthrough generated by the PM Agent.  
  *   
  * Side-by-side visual diffs or embedded preview iframe.  
  *   
  * "Approve & Deploy" action button.  
  * 

## **6\. Mobile & Tablet Responsiveness Rules**

* **Column Layout:** On screens \< 768px, collapse the 5-column board into a horizontal swipe view or sticky column tab bar at the top (Backlog | To Do | In Progress | In Review | Done).  
*   
* **Interaction:** Drag-and-drop is replaced with a single-tap "Advance Card" floating button or long-press context menu on mobile.  
*   
* **Drawers:** All modals automatically convert to full-screen bottom sheets on mobile devices.  
* 

Would you like me to generate a set of sample JSON mock data representing a realistic Epic and its child tickets so your designer has real copy to populate these screens?  
