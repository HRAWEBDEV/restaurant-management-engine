# Product Scope

`restaurant-manager-api` is the authoritative backend for a restaurant's operational state. It owns
the domain rules for catalog, floor, orders, kitchen, inventory, staff, and money, and exposes them
through a consistent, validated API consumed by any number of clients (POS, kitchen display,
customer ordering, admin, back office). It enforces state transitions, money integrity,
concurrency, idempotency, tenancy, and permissions in one place, so every surface shares a single
source of truth. Reports, tickets, and stock levels are derived projections of the event stream,
not separately maintained data.

## Implementation status

The build order for implementing the domains below lives in [docs/plan.md](plan.md) (master
plan) with one detailed document per phase under `docs/plan/`.

The tenancy foundation is built; the operational domains below are scoped but not implemented.

| Domain | Status | Notes |
| --- | --- | --- |
| Identity & auth | **Built** | Better Auth (email/password + username), session cookies, profile management |
| Tenancy (organizations, workspaces, members) | **Built** | Services + routes for organizations, users, workspaces, and members (list, role update, removal) |
| Invitations | **Built** | Send/list/revoke/accept shipped as routes (see `docs/api.md`) |
| Audit log | **Built (partial writers)** | `activity_logs` + `ActivityLogger`; organization/workspace/member/invitation mutations audited |
| Permissions scaffold | **Built (partial enforcement)** | Catalogs + `checkLevelPermissions`/`requireLevelPermissions`; enforced on organization/workspace update routes, workspace member management, and invitation routes |
| Catalog, Floor, Orders, Kitchen, Inventory, Staff, Payments, Reporting | **Planned** | See capabilities below |

## Capabilities

### Catalog

1. Create, read, update, and archive menu items.
2. Organize items into categories and menus.
3. Define item variants.
4. Define modifier groups with min/max and required rules.
5. Nest modifier groups.
6. Define modifier price deltas.
7. Resolve final item price deterministically.
8. Apply per-location price overrides.
9. Apply time-based availability windows and day-parts.
10. Mark items temporarily sold out (86).
11. Propagate 86 status across all channels.
12. Support item images and descriptions.
13. Support tax classes per item.
14. Support kitchen station routing per item.
15. Version menu changes with effective dates.

### Floor

16. Manage tables, sections, and capacity.
17. Model table state: free, seated, ordered, bill requested, dirty, free.
18. Seat walk-ins.
19. Create, modify, and cancel reservations.
20. Merge tables.
21. Split tables.
22. Transfer tables between servers.
23. Transfer items between tables and checks.
24. Assign servers to sections.
25. Track table turn time.

### Orders

26. Create draft orders.
27. Place orders.
28. Add, modify, and remove line items.
29. Attach modifiers to line items.
30. Attach notes to items and orders.
31. Support coursing.
32. Fire courses on demand.
33. Void items with reason codes and permission checks.
34. Comp items with reason codes and permission checks.
35. Split checks by seat, item, or amount.
36. Merge checks.
37. Apply discounts.
38. Enforce the order lifecycle state machine.
39. Reject illegal state transitions.
40. Version orders for optimistic concurrency.
41. Support idempotent order mutations.
42. Support order types: dine-in, takeaway, delivery.
43. Attach customer info to orders.
44. Generate public order tokens.

### Kitchen

45. Generate kitchen tickets from order events.
46. Route tickets to stations.
47. Track ticket state: queued, preparing, ready, served.
48. Track prep timers per item.
49. Support item bumping and recall.
50. Support expediting and course sequencing.
51. Reprint and re-route tickets.
52. Record ticket timing for reporting.

### Inventory & Recipes

53. Define ingredients and units of measure.
54. Define recipes as bills of materials.
55. Deplete stock on sale.
56. Deplete stock on modifier selection.
57. Record waste.
58. Record stock counts and adjustments.
59. Set par levels and reorder thresholds.
60. Track supplier records.
61. Track purchase orders and receipts.
62. Compute theoretical vs actual usage.
63. Track yield and conversion factors.

### Staff & Labor

64. Manage staff records.
65. Assign roles and permissions.
66. Clock in and clock out.
67. Manage shifts and schedules.
68. Compute labor cost against sales.
69. Attribute sales to staff.
70. Compute tip pools.
71. Record tip payouts.
72. Enforce role-based access on every mutation.

### Payments & Billing

73. Record payments as an immutable ledger in integer minor units.
74. Support multiple tender types.
75. Support split payments.
76. Support partial payments.
77. Apply tax rules.
78. Apply service charges.
79. Record tips separately from sales.
80. Process refunds.
81. Process voids with audit trail.
82. Reconcile cash drawer at close.
83. Run end-of-day close.
84. Export transactions to external processors.
85. Never store card data.

### Reporting

86. Report sales by item, category, server, and period.
87. Report food cost and COGS.
88. Report labor cost percentage.
89. Report menu engineering matrix.
90. Report waste and variance.
91. Report table turn and ticket times.
92. Derive all reports from the event stream.
93. Support business-day boundaries in location timezone.

### Platform & Technical

94. Multi-tenant model: tenant, location, resource (see `docs/data-model.md` for the tenancy
    design).
95. Validate every request against a schema.
96. Publish an OpenAPI document.
97. Emit domain events for every state change.
98. Expose webhooks for integrations.
99. Support offline client sync with conflict resolution.
100. Maintain an append-only audit log.
101. Version and migrate the database schema.
102. Validate configuration at startup.
103. Integrate with receipt printers.
104. Integrate with payment terminals.
105. Integrate with delivery aggregators.
106. Integrate with accounting systems.
107. Support loyalty and customer accounts.
108. Expose health and readiness endpoints.
109. Enforce rate limits and request logging.

## Cross-cutting rules that shape every domain

- **Tenancy first.** Every operational row carries a `workspace_id` FK; every query is scoped by an
  authorized workspace. Workspace access requires organization membership (`docs/data-model.md`).
- **Permissions on every mutation.** Route handlers resolve roles from membership rows and check
  `checkLevelPermissions(...)` — never from client input.
- **Money is integer minor units.** Payments are an immutable ledger; never store card data.
- **Audit every state change.** Each mutation writes an `activity_logs` row on the same transaction
  via `ActivityLogger`, using the entity's definition from `src/utils/activityDefinitions.ts`.
- **Events over projections.** Reports, kitchen tickets, and stock levels remain derived
  projections of domain events; event emission is not implemented yet.
- **Idempotency and optimistic concurrency** are required for order mutations (version columns,
  idempotency keys) once the orders domain lands.
