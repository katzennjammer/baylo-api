# Baylo Admin Console — Use Case Diagrams

UML use case diagrams for the admin side of Baylo, derived from the actual
admin surface (`src/app/admin/**`) and the API routes that back it
(`src/app/api/admin/**`, each gated by `requireRole(...)`).

## Files

| Diagram | Source | PNG | Notes |
|---|---|
| All roles (overview) | `use-case-admin-all.puml` | `png/use-case-admin-all.png` | One-slide overview of the whole console and how the three roles relate |
| Moderator | `use-case-moderator.puml` | `png/use-case-moderator.png` | The minimum staff role; everything below this level is shared |
| Admin | `use-case-admin.puml` | `png/use-case-admin.png` | Moderator + user account controls |
| Super Admin | `use-case-super-admin.puml` | `png/use-case-super-admin.png` | Admin + staff-role management |

## Roles

Roles are modelled with **actor generalization**, which matches the code:
`SUPER_ADMIN` inherits `ADMIN`, which inherits `MODERATOR`.

- **Moderator** — the shared staff console: reports, ID checks, anomalies,
  appeals, listings, hubs, audit log, trade-reward reversal.
- **Admin** — adds `Search / inspect users` and `Suspend / unsuspend account`.
  The Users page is hidden from Moderators in `admin/layout.tsx`; the suspend
  route (`/api/admin/users/[id]`) requires `ADMIN`.
- **Super Admin** — adds `Change staff role` (the Access page,
  `/api/admin/access`, requires `SUPER_ADMIN`).

Every write action requires a typed reason and writes an `AdminAction` audit
row — that is why "a reason is required" appears throughout the diagrams.

## Regenerating the PNGs

The `.puml` files are the source of truth. `render.ps1` renders each one to PNG
via the public PlantUML server, so **no Java or PlantUML install is needed** —
only PowerShell.

```powershell
cd baylo-api/docs/diagrams
.\render.ps1                 # render every .puml
.\render.ps1 -Only moderator # render just one (substring match)
```

Output goes to `png/`.

## Editing tips

- Keep `left to right direction` and the skinparam block as-is; the diagrams
  are laid out to stay legible at three actors and 8–13 use cases.
- Use coarse, aggregate use cases in the overview / per-role files
  (e.g. "Moderate reports") rather than one ellipse per button — a fan of 18
  associations per actor renders as unreadable spaghetti.
- Avoid `skinparam padding`; it makes PlantUML emit a "use CSS instead"
  warning that can suppress label rendering on the public server.
