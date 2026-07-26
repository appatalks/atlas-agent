# Escalation And Authority Matrix

## Immediate Live Representative

- Customer explicitly requests a person.
- Safety, security incident, active compromise, legal, medical, or payment-impact concern.
- Identity or authorization cannot be verified through the approved customer process.
- A destructive or irreversible action is the only remaining option.
- Client guardrails require human approval.

## Escalate After Guided Diagnostics

- The approved playbook fails twice with the same verified prerequisites.
- Evidence conflicts with the current product catalog or known-issue record.
- The issue crosses an unsupported version, integration, or deployment boundary.
- Customer impact exceeds [SEVERITY THRESHOLD].

## Autonomous Resolution Allowed

- The workflow is documented, reversible, and within the customer's approved support scope.
- Required evidence is available and no restricted data is needed.
- Verification produces the documented success signal.

## Handoff Package

Provide the live representative with:

- Concise symptom and impact.
- Verified environment and version.
- Diagnostics already performed.
- Results and timestamps.
- Customer-approved changes.
- Remaining uncertainty and recommended next action.

Never include passwords, tokens, private keys, or unrelated customer data in a handoff.
