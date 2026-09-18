# Roadmap

## WubLabz 1.0 status

WubLabz 1.0 is the stable local-first release line. The production release gate covers deterministic playback, producer tools, Flip Prep, worker-backed analysis, WubPad control, export, persistence, type safety, tests, build output, server smoke validation, and production dependency auditing.

The following items are post-1.0 enhancements rather than blockers for the stable local product:

## Playback evolution

- Expand typed marker/control actions into richer timeline-native automation where it improves musical behavior.
- Add a public runtime API for externally supplied `TimelineEventV2[]` when remote/editor integrations require it.
- Continue increasing browser-level timing and lifecycle coverage beyond deterministic unit tests.

## Worker evolution

- Add more end-to-end worker lifecycle stress tests.
- Add non-blocking progress telemetry for long analysis jobs.
- Evaluate optional additional separator backends without creating a second audio architecture.

## Producer intelligence evolution

- Add target-genre-specific callback motif suffixing.
- Add richer phrase-recall roles.
- Add persistent producer-diagnostics history snapshots.

## Product evolution

- Continue accessibility, onboarding, project-template, and deployment packaging improvements.
- Treat hosted multi-tenant operation as a separate product effort with authentication, quotas, storage isolation, observability, and service-level controls.
