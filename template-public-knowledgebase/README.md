# Public Knowledge Base Template

Use this folder for organization-approved documentation that is safe to reference for every client. ATLAS imports it into `.atlas/public-knowledge.sqlite`; the conversation model receives only retrieved excerpts and cannot query the database directly.

This folder remains the authoritative shared source even when client knowledge uses Azure Data Explorer. ATLAS materializes it into a local public cache and adds retrieved excerpts to every client session.

Add public product documentation, general troubleshooting, published support policies, and reusable procedures under `knowledge/`. Never put client-specific account data, private contracts, credentials, personal data, or internal-only records here.

Maintain `GLOBAL-GUARDRAILS.md` as operator-controlled policy. Public reference files cannot override it.