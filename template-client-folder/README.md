# Supplementary Client Context Template

Use this fictional folder only when a database client needs additive reviewed files or meeting artifacts. The database client remains the primary identity and knowledge source.

1. Update `client-profile.json` for the client.
	Keep the generated stable `id`. Set `knowledgeDatabase` only when this client needs an explicit ADX database override.
2. Put authoritative client references in `knowledge/`, `skills/`, or `context-drop/`.
3. Review `context-drop/CONTEXT-GUARDRAILS.md` before loading context.
4. Attach the folder as **Supplementary session context** and choose **Load context** to merge it into the selected client's isolated cache.

Do not put reusable public documentation here. Add it to the separately configured public knowledge base. Keep real client workspaces outside this repository and do not commit client data or generated `.atsla/` databases.