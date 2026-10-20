# mdpm for VS Code

An AI flow for markdown ideas that live in your repo: **idea → plan → executing → review →
done**. You write ideas and approve plans; the agent plans and builds, one idea at a time; you
review the work. See the main README at the root of the mdpm repo for the file format.

Website and support: <https://mdpm.availabooks.com>

## The flow board

*mdpm: Open Flow Board* shows the columns **Idea · Plan · Executing · Review · Done**. Each
card says where it stands (*Awaiting your approval*, *Approved · #2 in queue*, *Needs your
answer*, *Ready for your review*) and offers the next step on hover:

| Column | Actions |
|---|---|
| Idea | **▶ Plan now**: the agent plans it in a terminal |
| Plan | **✓ Approve** (joins the execution queue), ↺ re-plan |
| Executing | 💬 continue with the agent; blocked cards: **Answer** |
| Review | **✓ Accept**, ↩ rework (with feedback; executed next), PR |

The toolbar shows what holds the execution slot, how many ideas wait on you, and **▶ Run
next**, which runs the agent once on whatever is next in the flow.

Dragging a card does what that move means in the flow (Review → Done accepts, Plan →
Executing starts an approved plan, and so on). Moves that aren't part of the flow are
refused, with the reason.

## Working with several ideas at once

Ctrl+click (Cmd+click on macOS) cards to select them; the toolbar then offers **Approve** and
**Accept** for the selected ideas they apply to. In the Projects tree, Ctrl/Cmd+click ideas,
then right-click and choose **Approve Plan** or **Accept**. A plain click still opens the
idea and clears the selection.

Changes are validated before anything is written. If a change would make some ideas invalid,
one dialog lists them all: **Save Anyway** writes every idea, **Skip Invalid** writes only the
valid ones.
