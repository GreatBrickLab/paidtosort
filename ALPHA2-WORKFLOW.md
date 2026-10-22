# Paid to Sort — Alpha 2 workflow (one page)

**Idea:** one sorter, one session, one list. A session is just a list of checked lots (part + color + qty) you can export. No batches, boxes, bags, put-away, pay or roles.

## The loop
1. **Sign in** (username + password, added by Chris with `scripts/adduser.mjs`).
2. **Start a session.** Name is optional (defaults to date). You can scan a label to name it.
3. **Photograph** up to ~20 parts spread on a plain sheet.
4. **Boxes.** The phone draws a numbered box on each part. Drag on the photo to add any it missed, then tap **Done**.
5. **Identify.** Each box is sent through our server and comes back with a part number, a color guess and a score. Anything it can't recognise is dropped, so take a closer photo of those.
6. **Check cards.** The photo stays pinned with numbered, score-coloured boxes; tap a box to jump to its card.
   - Each card shows the part, a score bar, other matches, and a swipe-up side-by-side of *our match* and *your photo*.
   - You can fix the color (with **Show all colors**) and qty.
   - **✓ Add to lots** or **Drop**; **Confirm all** for the rest.
7. **Lot list.** One line per part + color. Adding the same part again bumps the qty. Each line shows est. weight (oz under 1 lb, lb above). Tap a line to change qty, color or part, or to remove it.
8. **Repeat** steps 3–7 until the pile is done.
9. **Finish.** Optionally enter what the pile weighed (lb or oz). If there are unchecked cards it asks first; finishing anyway drops them.
10. **Export.** Spreadsheet (CSV) and Inventory file (.bsx). Every time is shown in CT. **Reopen** to fix mistakes.

## What's stored
- `users`
- `sessions` (name, started/ended, weighed, open/done)
- `lots` (part, color, qty, score, matches, small crop, check/ok)

That's the whole schema. Photos stay on the phone.
