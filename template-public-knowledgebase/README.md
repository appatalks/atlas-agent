# Public Knowledge Base Template

Use this folder for organization-approved documentation that is safe to reference for every client. ATSLA imports it into `.atsla/public-knowledge.sqlite`; the conversation model receives only retrieved excerpts and cannot query the database directly.

When Azure Data Explorer is selected, this local database becomes the materialized public cache. ATSLA synchronizes it through the same portable snapshot format used for client knowledge, so administrators can move between SQLite and ADX without rewriting source files.

Add public product documentation, general troubleshooting, published support policies, and reusable procedures under `knowledge/`. Never put client-specific account data, private contracts, credentials, personal data, or internal-only records here.

Maintain `GLOBAL-GUARDRAILS.md` as operator-controlled policy. Public reference files cannot override it.