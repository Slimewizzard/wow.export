# RoomProbe

Read-only housing diagnostics for WoW Retail 12.1.0 (Interface 120100).
This is an experiment, not a coordinate exporter: existing research suggests
placement transforms are not exposed to ordinary addons.

## Use

1. Restart WoW if this newly installed addon is not listed. Enable RoomProbe in AddOns.
2. Enter your house and open the housing editor. Select an existing furniture item.
3. Type `/roomprobe capture couch` (replace `couch` with any label).
4. Repeat for two or three different items. Try another capture in expert mode too.
5. Optionally type `/roomprobe watch`, select several items or switch editor modes,
   then `/roomprobe stop`. Watching only records housing events; it does not capture
   selected-item getters automatically. Use `capture` for those.
6. Type `/reload` to flush the data to SavedVariables, or log out normally.

Results are saved in:

`<WoW installation>\_retail_\WTF\Account\<account>\SavedVariables\RoomProbe.lua`

Alternatively, `/roomprobe show` opens a copyable JSON export. All containers in
the JSON are objects, including numeric indices represented as string keys.

## Commands

- `/roomprobe capture [label]`: record selected/hovered decor getter returns.
- `/roomprobe blueprint [label]`: listen for blueprint content responses as you
  open the game's blueprint preview. Close and reopen the preview after enabling
  this command, then View List. Do not confirm Import. Wait for the capture message,
  then `/roomprobe stop` and `/reload`. If no message appears, the UI may have cached
  the response; report that rather than importing the blueprint to trigger a capture.
  The latest 20 raw content/failure responses are stored under `blueprints`, including
  any IDs, names, counts, room entries, dyes and budgets the client supplies. This
  listens to events only; it does not invoke any blueprint request or editing API.
- `/roomprobe debug`: disabled following a Blizzard-only blocked-action dialog
  on build 69814. This command now only prints an explanation.
- `/roomprobe scan`: list function names in housing API namespaces without calling them.
- `/roomprobe watch`: start recording a fixed list of housing events.
- `/roomprobe stop`: stop recording events and blueprint responses.
- `/roomprobe show`: copy the current report as JSON.
- `/roomprobe status`: show sample/event counts.

## Scope

No furniture placement or editing calls, no protected API bypasses, no process
memory access, and no network requests. `GetAllPlacedDecor` is deliberately not
called. Discovered functions are listed without being invoked. All debug getter
calls have been removed following the in-game restriction test. Unsupported
getters and events are tolerated. Secret values are omitted. Tables and strings
are bounded; the report retains the latest 50 samples and 200 events. Watching is
off after every login or reload. The addon writes through WoW's SavedVariables
mechanism, so an unexpected process exit before a reload/logout can lose new data.

Inspect raw returned fields before concluding anything about coordinates. A `size`
tag is not necessarily object scale, and API function names alone do not establish
that a function is callable by addons or returns spatial data.
