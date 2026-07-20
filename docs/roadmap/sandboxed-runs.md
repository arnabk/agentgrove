# Sandboxed unattended runs

> Status: **deferred.** Platform track.

## Idea

Run agents in containers (or Lima VMs) per workspace so
`--dangerously-skip-permissions` isn't required for unattended runs
(groundcrew sandboxes by default).

## Notes

- Heavy infra (image management, filesystem bridging, networking) for
  a problem the solo-dev target user doesn't feel today.
- Revisit if/when scheduled automations make unattended runs common —
  that's when sandboxing stops being optional.

## Effort

L.
