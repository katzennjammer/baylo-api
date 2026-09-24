# Baylo Admin Console — Use Case Diagrams

UML use case diagrams for the admin side of Baylo, derived from the actual
admin surface (`src/app/admin/**`) and the API routes that back it
(`src/app/api/admin/**`, each gated by `requireRole("ADMIN")`).

## Files
| Diagram | Source | PNG | Notes |
|---|---|
| Admin (overview + detail) | `use-case-admin.puml` | `png/use-case-admin.png` | The whole console, with USER and ADMIN as the only two actors |

> The Moderator and Super Admin diagrams (`use-case-moderator.puml`,
> `use-case-super-admin.puml`) were **removed**: those roles no longer exist.
> `Role` in `@/lib/api-auth` is now `"USER" | "ADMIN"`, and every admin route
> asks for `ADMIN`.

## Roles
There are exactly **two roles**, and the boundary between them is total:

- **User** — the Android app only. A plain user has *no* use case inside this
  console; `/admin` redirects a non-ADMIN to `/dashboard`.
- **Admin** — everything in the console: the report queue and moderation
  actions, ID checks, value-review anomalies, appeals, user search and
  suspension, listings, Safe-Zone hubs, achievement definitions, trade-reward
  reversal, the audit log, and the overview.

Two consequences worth knowing, both enforced in code:

- An **ADMIN cannot be suspended through the API** — `/api/admin/users/[id]`
  refuses a target whose role is `ADMIN`.
- **Promotion to ADMIN is manual SQL.** There is no endpoint that grants the
  role, precisely so there is no privilege-escalation target.

Every write action requires a typed reason and writes an `AdminAction` audit
row — that is why "a reason is required" appears throughout the diagram.

## Regenerating the PNGs

The `.puml` files are the source of truth. `render.ps1` renders each one to PNG
via the public PlantUML server, so **no Java or PlantUML install is needed** —
only PowerShell.

```powershell
cd baylo-api/docs/diagrams
.\render.ps1             # render every .puml
.\render.ps1 -Only admin # render just one (substring match)
```

Output goes to `png/`.

## Editing tips

- Keep `left to right direction` and the skinparam block as-is; the diagram
  is laid out to stay legible at two actors and ~13 use cases.
- Use coarse, aggregate use cases (e.g. "Decide appeals") rather than one
  ellipse per button — a fan of 18 associations per actor renders as
  unreadable spaghetti.
- Avoid `skinparam padding`; it makes PlantUML emit a "use CSS instead"
  warning that can suppress label rendering on the public server.
