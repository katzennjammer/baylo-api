<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Branches: the defense server runs `integration/defense`

The defense server runs `integration/defense` in BOTH repos (this API and baylo-mobile).

- Finished features merge INTO `integration/defense` with `git merge --no-ff` (a real merge commit). No rebase, no force-push.
- `main` is merged later, with the team. Do not merge `integration/defense` into `main`, or `main` into it, on your own.
