# Basic Example

## Scenario

Prove one allowed and one denied authorization decision through an installed `permission-core` package before adding a framework or database.

## Runnable source

The page and package-consumer smoke use the same repository-owned file:

```js file="<root>/../examples/docs-first-success.mjs"

```

Run the isolated installed-package check from the repository root:

```bash
npm run docs:first-success
```

## Expected result

The command packs the current project, installs the tarball into an empty temporary consumer, and prints exactly:

```text
[first-success] allowed=true blocked=true
```

## Fits and does not fit

Use this as the first package/install/runtime proof. It fits local evaluation and release-channel smoke testing. It does not demonstrate persistence, tenant isolation, framework middleware, row scopes, fields, or menu workflows; continue with the corresponding guide only after this result passes.
