# Gitterdone — Product Requirements Document (Rebuild)

> **Purpose of this doc:** A from-scratch PRD describing every feature of the
> existing Gitterdone web app, written so it can be used as the basis for a new
> build and roadmap. Feature set reverse-engineered from the live deployment at
> `https://app.gitterdone.org` (Next.js App Router + Supabase, PWA).

---

## 1. Overview

**What it is:** Gitterdone is an internal **team task-management app for Buena**.
It blends a normal task/project tracker (boards, lists, sprints, time tracking)
with a light **gamification + accountability layer** (weekly commitments, points,
leaderboard, streaks, and a "spin the wheel" weekly reward) and a **manager's
operations view** (team agenda, daily recap, time-by-project billing export,
Google Calendar integration).

**Who it's for:**
- **Members** — individual contributors who own and complete tasks.
- **Admins/Managers** — set up clients/projects, assign or pool work, review
  suggestions, run the weekly reward, and report on team time/output.

**Platforms:** Responsive web app, installable as a **PWA** (standalone display,
maskable icons, dark theme `#1B1B1A`). A separate thin **Electron desktop shell**
(`gitterdone-desktop`) wraps the live URL for a double-clickable macOS app.

**Design language:** Dark-first, CSS-variable themed (`--bg-main`, `--text-second`,
etc.), Geist + Geist Mono fonts, with a **theme toggle**. Toast notifications,
modals, keyboard-first interactions.

---

## 2. Goals & Non-Goals

**Goals**
- Give every member one place to see *what they should do today* and log progress.
- Make weekly accountability visible and a little fun (commitments → points → reward).
- Give managers real-time visibility into team workload, focus, and billable time.
- Stay fast and low-friction: keyboard shortcuts, inline edits, drag-and-drop.

**Non-Goals (for v1 rebuild)**
- Not a public/multi-tenant SaaS — it's a single Buena workspace.
- Not a full PM suite (no Gantt, no dependencies graph, no resource leveling).
- Not a CRM — "Clients" exist only to organize projects and billing.

---

## 3. Roles & Permissions

| Role | Capabilities |
|------|--------------|
| **Member** | Create/edit/complete **their own** tasks, log time, set weekly commitments & goal, suggest tasks, pick up pooled tasks, view leaderboard/recap. |
| **Admin** | Everything members can do **plus**: manage clients/projects, manage team members & invites, assign tasks to anyone, approve/reject task suggestions, spin the weekly reward, broadcast announcements, connect members' Google Calendars, edit anyone's commitments. |

**Permission rules observed (must be enforced server-side):**
- "You can only move your own tasks."
- "You don't have permission to delete this task."
- "You don't have permission to do that."

---

## 4. Authentication & Workspace

- **Sign in to your workspace** screen (Supabase Auth). Email-based login;
  Supabase session with realtime + storage.
- **Member invites:** admin invites by email (`POST /api/users/:id/invite`).
  Guard: "This member has no email. Add one first."
- Session shows "You're logged in as …".

---

## 5. Core Domain Model

```
Client ──< Project ──< Task ──< { Comments, Attachments, Activities, TimeEntries, Subtasks }
User (member/admin) ──< assigned Tasks, TimeEntries, WeeklyGoals, WeeklySpins
Sprint ──< Tasks (linkable/unlinkable)
ScheduledBlock (day-planner time blocks)  ──> optional Task ref
TaskTemplate (reusable task presets)
TaskSuggestion (proposed task → approve → Task)
Notification, Broadcast
GoogleCalendar connection (per user)
```

Key entities & fields (inferred):
- **Task:** title, description, status (`todo`/`in_progress`/`blocked`/`done`),
  priority (`low`/`medium`/`high`/`urgent`), assignee, project, due_date,
  estimated_minutes, archived flag, subtasks, created/updated timestamps.
- **TimeEntry:** task_id, user, minutes_logged, start/stop, running state.
- **WeeklyGoal:** week, user, position (the **5 commitment slots**), text goal.
- **WeeklySpin:** week, reward (the prize the wheel landed on).

---

## 6. Feature Areas

### 6.1 Tasks
- **Create Task** modal (title required, description, project, assignee, priority,
  due date, estimate).
- **Create Many Tasks** — bulk add, "One task per line."
- **Edit inline** ("Click to edit"), change status ("Mark as done", "Mark as to do",
  "Mark not done"), change priority, set due date.
- **Archive / Unarchive** task; **Delete** task (with confirm + permission check).
- **Subtasks** — toggle/expand ("Toggle subtasks").
- **Comments** — per-task thread (`/api/tasks/:id/comments`), "No comments yet".
- **Attachments** — upload/download/delete files (Supabase storage,
  `/api/tasks/:id/attachments`, `/api/attachments/:id`).
- **Activity log** — per-task audit trail (`/api/tasks/:id/activities`),
  "No activity yet."
- **Share:** "Copy link to this task" and "Copy public share link" (public, read-only).
- **Bulk actions** — "Select mode", "Select for bulk action", "Clear selection".

### 6.2 Views (toggleable / declutterable)
The view switcher is configurable per user — **"Hide views you don't use to
declutter the menu"**, **"Visible tools"**.
- **Board / Kanban view** — columns by status, drag-to-move cards, configurable
  card ordering ("How cards are ordered within each column", "Manual order",
  "Drag to reorder").
- **List view** — sortable/filterable table.
- **Sprint view** — work grouped by sprint.
- **Calendar / Today's calendar** — schedule-oriented.
- **Focus Timeline** — focus/time visualization.
- **Team Agenda** — manager view of everyone's day.

### 6.3 Filtering & Search
- Global **"Search anything"**, plus scoped "Search tasks…", "Search projects…".
- Filters: **All Statuses, All Priorities, All Projects, All Sprints, All Members**.
- Context scoping: "Viewing client", "Viewing project", "Back to me" /
  "Project Mode" toggles.

### 6.4 Clients & Projects
- **Clients:** Add/edit/delete client, "Clients List", empty state "No clients yet".
- **Projects:** Add/edit/delete project, "Projects List", assign users to projects
  (`/api/users/:id/projects`), "No Project" bucket for unassigned tasks.

### 6.5 Sprints
- Create ("New Sprint" / "Create your first sprint to get started."), Edit Sprint
  with **Start Date**, delete ("Delete this sprint? Tasks will be unlinked but kept.").
- Add/remove tasks from a sprint ("Remove from sprint", "Pick existing task").

### 6.6 Time Tracking
- **Start/Stop timer** per task; **Pause** ("Pause — keeps the time logged so far").
- Manual **time entries** (create/edit/delete, "Delete this time entry?").
- Reporting: **Time by Project**, **Total hours**, "No time tracked today/this month".
- **Est. vs actual** efficiency, **Plan vs Actual**, "Total est." per task/group.

### 6.7 Day Planner / Scheduled Blocks
- A time-slot day plan (`/api/scheduled-blocks?date=…`).
- Drag tasks onto slots: "Drag onto a time slot to schedule", "Click to add planned
  item", "Plan an item for …", "Drag to change start/duration", "Clear slot".

### 6.8 Task Pool & Suggestions (lightweight workflow)
- **Assignable Tasks / task pool** — unassigned tasks members can claim
  ("Click to pick one up", "Unassigned").
- **Task Suggestions** — members propose tasks; admins **approve/reject**
  (`/api/task-suggestions/:id/approve`, "Suggested tasks", "No suggestions yet.").
- **Task Templates** — "Save current values as a reusable template" (title required),
  reuse to prefill new tasks.

### 6.9 Weekly Accountability + Gamification ⭐ (the differentiator)
- **Weekly commitments:** each member sets up to **5 committed tasks/goals** for the
  week (`/api/weekly-goals?week=…&position=…`) plus an optional free-text **Goal**.
  Admins can edit a member's commitments ("…'s commitments. Changes are saved to
  their account.").
- **Points / Leaderboard:** scoring is transparent and shown to users —
  **+5 per task completed this week, +5 bonus if it was one of your 5 commitments
  (so a committed task = 10), +5 bonus if done on or before the due date.**
  Leaderboard ranks members by weekly total with a per-task breakdown of reasons.
- **Streaks:** "Day streak — keep it going!" based on consecutive days with
  completed tasks.
- **Weekly Roulette / Spin reward:** admin **spins the wheel** to pick "This week's
  reward" (`/api/weekly-spins`). Animated spin ("Spinning…", ~3.3s), result
  "Reward locked in!", supports **Re-spin** with confirm. Members see
  "Waiting for admin to spin the reward." / "No reward yet — spin the wheel below."
  Eligibility gate observed (e.g. each member has ≥5 completed tasks).

### 6.10 Daily Recap / Highlights
- **Daily Recap** with **Today's Highlights** computed from the day's activity:
  streak callout, "X% more efficient than estimated", "N tasks completed today",
  "<name> got the most focus today", "Longest focus session: …".
- **Completed Today**, **Tasks completed**, **Total Tasks** counters.
- **Share Recap** (shareable summary). Empty: "Complete some tasks to see highlights!"

### 6.11 Team Agenda & Manager Tools
- **Team Agenda / Team submissions** — see the whole team's planned day
  ("Whole team", "All Members", "Add team members to see their agenda.").
- **Broadcast** — admin announcement to the team (`/api/broadcast`).
- **Team Members** management in Settings (add member, invite, remove).

### 6.12 Google Calendar Integration
- Per-member **Connect Calendar** via OAuth (`/api/google/auth`, `/status`,
  `/disconnect`). Admin can "Connect this member's Google Calendar."
- Pull events into the day view (`/api/google/events?user_id=…&from=…&to=…`),
  "Calendar connected", "Disconnect Google Calendar".

### 6.13 Billing / Export
- **Time-by-project export** for invoicing: CSV columns
  `Project,User,Hours,Tasks,Rate,Amount`; "Same shape as Ramp / Quickbooks import",
  "Invoice — …", per-project **Rate**.

### 6.14 Notifications
- In-app notifications (`/api/notifications`, `/mark-read`), **Mark all read**,
  realtime updates via Supabase channels. Empty: "No notifications yet".

### 6.15 Settings & Profile
- **My Profile**, **Settings** (team members, visible tools/views, theme).
- **Toggle theme** (dark/light).

### 6.16 Keyboard Shortcuts & Productivity
- Shortcuts overlay (**?** toggles help). Known bindings: **n** = New task,
  **Esc** = Close modals, **?** = Toggle shortcuts help. "Keyboard Shortcuts" panel.

---

## 7. Real-time & Sync
- Supabase **realtime channels** keep boards, weekly goals/spins, and notifications
  live across clients (e.g. `weekly-<week>` channel subscriptions).
- Optimistic UI with toasts on success/failure ("Link copied!", "Failed to move task").

---

## 8. Technical Architecture (current)

- **Frontend:** Next.js (App Router, RSC + client components), Tailwind via CSS
  variables, Geist fonts, deployed on **Vercel**. PWA (`manifest.json`, service
  worker behavior, installable).
- **Backend:** Next.js Route Handlers under `/api/*` (see appendix), backed by
  **Supabase** (Postgres, Auth, Realtime, Storage for attachments).
- **Integrations:** Google Calendar OAuth.
- **Desktop:** Electron wrapper (`gitterdone-desktop`) loading the live URL; external
  links open in the system browser; auto-retry on failed load.

---

## 9. Suggested Rebuild Roadmap (phased)

**Phase 1 — Foundation**
- Auth + workspace, roles (member/admin), users/invites.
- Clients → Projects → Tasks CRUD; List + Board views; filters & search.
- Comments, attachments, activity log; permissions enforcement.

**Phase 2 — Time & Planning**
- Time tracking (timer + manual entries), Est. vs actual.
- Day planner / scheduled blocks; Sprints; Calendar view.

**Phase 3 — Accountability & Gamification**
- Weekly commitments (5 slots) + goal; points engine + leaderboard; streaks.
- Weekly Roulette reward (admin spin + re-spin); Daily Recap + Share Recap.

**Phase 4 — Team Ops & Integrations**
- Team Agenda, broadcasts, notifications (realtime).
- Google Calendar integration; task suggestions + approval; task pool/claiming; templates.

**Phase 5 — Reporting & Polish**
- Time-by-project billing export (Ramp/Quickbooks shape, rates).
- View configurability, keyboard shortcuts, theme, PWA, desktop shell.

---

## Appendix A — API Surface (observed)

```
/api/users            /api/users/:id            /api/users/:id/invite      /api/users/:id/projects
/api/clients          /api/clients/:id
/api/projects         /api/projects/:id
/api/tasks            /api/tasks/:id            /api/tasks/:id/comments
/api/tasks/:id/attachments   /api/tasks/:id/activities   /api/tasks/:id/time-entries
/api/attachments/:id
/api/time-entries/:id
/api/sprints          /api/sprints/:id
/api/scheduled-blocks /api/scheduled-blocks/:id  (?date=)
/api/task-templates
/api/task-suggestions /api/task-suggestions/:id  /api/task-suggestions/:id/approve
/api/weekly-goals     (?week=&position=)
/api/weekly-spins     (?week=)
/api/notifications    /api/notifications/mark-read
/api/broadcast
/api/google/auth      /api/google/status         /api/google/disconnect      /api/google/events
```

## Appendix B — Status / Priority / Role Enums
- **Status:** `todo`, `in_progress`, `blocked`, `done` (archived flag separate).
- **Priority:** `low`, `medium`, `high`, `urgent`.
- **Roles:** `member`, `admin`.
- **Suggestion lifecycle:** `pending` → `approved` / `rejected`.

## Appendix C — Points Formula (verbatim from UI)
> +5 per task completed this week · +5 bonus if it was one of your 5 commitments
> (so a committed task = 10) · +5 bonus if done on or before the due date.
