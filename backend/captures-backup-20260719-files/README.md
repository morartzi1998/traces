# Pre-reset backup — 2026-07-19

Full binary backup of every capture file that was still actually fetchable
from the shared Cloudflare Worker store at backup time, taken so nothing is
lost if the planned archive reset/re-upload doesn't go smoothly.

Paired with `../captures-backup-20260719.json` / `.md`, which hold the text
side (titles, feelings, annotations, attribution) for **all 31** records —
this folder only has the actual image/model bytes for the **4** records
whose files were still live:

- `cap-1784228652747` (crystal chandelier 3d model) — image only, no model
- `cap-1784389209315` (noga's trash bag bag) — image + model
- `cap-1784445629118` (orchid plant in the kitchen) — image + model

Everything else in the 31-record set had either no synced visual data at
all (several point-cloud captures never finished syncing their geometry),
or a Tripo signed URL that had already expired by the time this backup was
taken (Tripo links last only hours, not days) — those are unrecoverable
regardless of what's done here; only their titles/text survive, in the
metadata backup above.

Safe to delete this folder once the archive has been rebuilt from scratch
and confirmed working — it exists only as a rollback safety net.
