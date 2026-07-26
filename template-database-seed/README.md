# ATLAS Client Database Seed

This template creates a portable, client-scoped knowledge snapshot for a new ATLAS support database. Replace all bracketed placeholders before production use.

The structure separates authoritative seed knowledge from autonomously learned resolutions:

- `CLIENT-GUARDRAILS.md`: non-negotiable disclosure, authorization, safety, and escalation rules.
- `seed-manifest.json`: machine-readable ownership and review metadata.
- `knowledge/client-profile.md`: support scope and customer environment.
- `knowledge/product-catalog.md`: supported products, capabilities, and boundaries.
- `knowledge/troubleshooting-playbooks.md`: symptom-to-verification procedures.
- `knowledge/known-issues.md`: versioned defects and workarounds.
- `knowledge/escalation-matrix.md`: authority and handoff conditions.
- `knowledge/customer-preferences.md`: non-sensitive service preferences.
- `learned/`: reserved source-path namespace for evidence-backed autonomous updates.

Build a seed snapshot:

```bash
npm run seed:template -- client-id template-database-seed ./client-id.seed.json
```

Import the generated JSON from Settings or `POST /v1/knowledge/client/import` after selecting and loading the matching client ID. The snapshot scope ID must exactly match the selected client.

Seed documents carry `seed` authority and confidence 1. Autonomous learning cannot overwrite that authority through repetition. Keep credentials, access tokens, personal data, raw transcripts, private keys, and unrestricted production exports out of this template.
