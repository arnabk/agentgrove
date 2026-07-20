# Remote headless mode

> Status: candidate — not yet discussed in detail. Platform track.

## Idea

Run the backend on a server and reach it from anywhere (laptop, phone)
— Superset's remote workspaces.

## Notes

- The BE is already a web server with cross-instance sync; this is
  mostly hardening: auth token, HTTPS/tunnel docs, securing every
  endpoint (today it assumes localhost trust).
- Auth model is the real work, not networking.

## Effort

M-L.
