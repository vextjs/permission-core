# Unreleased

## 2026-06-11

- **Bilingual documentation site**: reorganized the Rspress docs into English default pages and `/zh/` Chinese pages, translated the root README to English, and added the published documentation link.
- **Payment-themed website design**: added a fintech-oriented Rspress theme for navigation, home hero, feature cards, tables, and code blocks.
- **Website visual refinement**: tightened the home navigation brand mark, rebuilt the hero layout, replaced the generated bitmap hero with a code-native SVG authorization flow, and replaced the heavy segmented rail with a lighter transaction line so the first viewport feels coherent across light, dark, desktop, and mobile views.
- **Website code block theme**: fixed light-mode fenced code blocks so they use a light payment-console surface while keeping dark mode code blocks dark.
- **Dependency compatibility line**: upgraded the verified production stack to `cache-hub@2.2.4 + monsqlize@2.0.3`, refreshed the Vitest toolchain to `3.2.6`, added a `msq.getCache()` regression test, and aligned production docs with the shared cache instance path.
- **Docs/Profile consistency**: aligned website version metadata, dependency matrix, MonSQLize setup snippets, rule deduplication wording, and DevCodex Profile state with the current `permission-core@1.0.9` implementation.
