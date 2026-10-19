# mdpm for VS Code

Kanban board, waterfall timeline and project tree for markdown tasks that live in your repo.
See the main README at the root of the mdpm repo for the file format.

## Working with several tasks at once

Ctrl+click (Cmd+click on macOS) a task to add it to the selection, or to remove it again.
A plain click still opens the task, and clears the selection.

- **Kanban board and Waterfall timeline:** Ctrl/Cmd+click cards or task labels (or bars on the
  timeline). Selected tasks are highlighted and the toolbar shows "N selected" with:
  - **Set status…**: offers the statuses that every selected task's project has. If the projects
    share none, narrow the selection.
  - **Set owner…**: sets one owner on all of them; leave it empty to unassign.
  - **Clear**: empties the selection. Escape, or a click on empty space, does the same.

  The selection survives refreshes. Tasks that are deleted or hidden by the filters drop out of it.
- **Board drag:** dragging a selected card moves all selected cards to the column you drop them
  on. Dragging a card that is not selected moves only that card.
- **Timeline drag:** dragging the middle of a selected bar shifts every selected scheduled task
  by the same number of days. The resize handles at the ends of a bar still change only that bar.
- **Projects tree:** Ctrl/Cmd+click tasks, then right-click and choose **Set Status…** or
  **Set Owner…** to change all of them. Selected projects are ignored.

Bulk changes are validated before anything is written. If the change would make some tasks
invalid, one dialog lists them all: **Save Anyway** writes every task, **Skip Invalid** writes
only the valid ones. If a file can't be written, the error names the tasks that were not saved,
the views show what is on disk, and **Retry** saves just those tasks again.
