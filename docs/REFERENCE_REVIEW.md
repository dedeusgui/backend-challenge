# Public implementation review (design research)

Reviewed on 2026-10-30: public repository layouts, package manifests
and architecture documents; **not** an independent execution or security
audit. These projects are references for trade-offs, not sources to copy.

1. [AndreLopes30/junglegaming-backend-challenge](https://github.com/AndreLopes30/junglegaming-backend-challenge):
   a compact layout, separate HTTP/worker entrypoints, PostgreSQL wallet
   row locking and integer minor-unit money representation. Its architecture
   explicitly acknowledges an Outbox publisher holding a DB transaction open
   while making an SQS call — simple but susceptible to long transactions.
2. [paulovitorlr/jungle-gaming-challenge](https://github.com/paulovitorlr/jungle-gaming-challenge):
   vertical wallet/wagering/messaging modules, explicit mappers, optimistic
   versioning and short Outbox claims with leases. Clear boundaries, but many
   nested folders and some entities under a catch-all shared area increase
   navigation overhead for a timeboxed exercise.
3. [eriksonwilliam/jungle-gaming-wagering](https://github.com/eriksonwilliam/jungle-gaming-wagering):
   domain/application/infrastructure separation and pessimistic locking,
   with a broader local stack (including Keycloak, metrics and dashboards).
   Useful as an operational reference, but wider than this challenge's
   scoring priorities.

## Decisions for this repository

- Keep **vertical business modules** with minimal shared infrastructure.
- Begin with **pessimistic Wallet row locking** and exact Money strings.
- Use **Inbox/Outbox** as durable infrastructure, not as a second wallet
  processor. Prefer short DB claims/leases over holding DB locks across SQS IO.
- Do not install Keycloak, Prometheus or Grafana without a test-driven need.
- Treat every behavior described above as a design proposal until tests
  prove that it works in this repository.

Sources: each linked repository's README, ARCHITECTURE.md and file tree.
