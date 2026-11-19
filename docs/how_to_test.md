# How to Test

Rules and conventions for writing tests in this codebase.

## 1. Colocated `__tests__` directories

Tests live next to the code they test, inside a `__tests__` directory created
within that module's own folder — never in a top-level test folder and never
mixed into the source directory itself.

- Testing something in `src/utils/` → `src/utils/__tests__/`
- Testing something in `src/db/` → `src/db/__tests__/`
- Testing something in `src/services/` → `src/services/__tests__/`
- Testing something in `src/v1/api/routes/` → `src/v1/api/routes/__tests__/`

Example layout:

```
src/utils/
  ActivityLogger.ts
  __tests__/
    activity.test.ts
src/db/
  connect.ts
  __tests__/
    connect.test.ts
```

Test files use the `*.test.ts` suffix (e.g. `permissions.test.ts`) so `bun test`
discovers them automatically. Shared helpers (DB harness, factories, cookie jar)
live in `src/utils/__tests__/helpers/` or alongside the module that owns them.

## 2. Test behavior, not current configuration

Tests assert what a function does — given a role that has a permission it
returns `true`, given one that doesn't it returns `false` — not the current
contents of configuration data. Do not lock in in-progress state (empty grant
lists, WIP permission sets, values that are expected to change as features are
built); tests that mirror configuration become churn on every iteration. When a
function operates on configuration data, derive its test inputs from that data
itself, so the tests survive configuration changes.
